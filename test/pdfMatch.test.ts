import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { glyphRects, matchPdfSelection, matchQuoteInPdf, pdfSkeleton, sourceSkeleton, type PdfGlyph } from '../src/shared/pdfMatch.ts';

/** The source text a selection maps to, with how it was found. */
function find(source: string, selected: string, first = 1, last = first): { text: string; kind: string } {
  const m = matchPdfSelection(source, selected, first, last);
  return { text: source.slice(m.from, m.to), kind: m.kind };
}

test('skeletons drop markup, spacing, case and accents', () => {
  assert.equal(sourceSkeleton(String.raw`We \emph{really} mean it % not this` + '\nnext').text, 'wereallymeanitnext');
  assert.equal(sourceSkeleton(String.raw`K\"ohler \label{x} \cite[p.~3]{a,b} done`).text, 'kohlerdone');
  assert.equal(pdfSkeleton('Köhler e\uFB03cient [3, 4] done'), 'kohlerefficientdone');
});

test('ligatures in the PDF text match plain letters in the source', () => {
  const src = 'An efficient field of view for the first figure.\n';
  assert.deepEqual(find(src, 'e\uFB03cient \uFB01eld of view'), { text: 'efficient field of view', kind: 'exact' });
});

test('words hyphenated across PDF lines match the unbroken source words', () => {
  const src = 'Bird counts are recorded\nwith a folding chair and\nsummed up offline.\n';
  assert.deepEqual(find(src, 'counts are rec-\norded with a fold-\ning chair', 1, 2), { text: 'counts are recorded\nwith a folding chair', kind: 'exact' });
});

test('\\emph and other formatting commands are skipped inside the match', () => {
  const src = String.raw`We \emph{strongly} believe that \textbf{this} holds.` + '\n';
  assert.deepEqual(find(src, 'strongly believe that this holds.'), { text: String.raw`strongly} believe that \textbf{this} holds.`, kind: 'exact' });
  assert.deepEqual(find(src, 'We strongly believe'), { text: String.raw`We \emph{strongly} believe`, kind: 'exact' });
});

test('a printed numeric citation takes in its \\cite command', () => {
  const src = String.raw`As shown before~\cite{smith20,doe21}. Next we turn to it.` + '\n';
  assert.deepEqual(find(src, 'shown before [3, 4].'), { text: String.raw`shown before~\cite{smith20,doe21}.`, kind: 'exact' });
  assert.deepEqual(find(src, 'before [12] . Next we'), { text: String.raw`before~\cite{smith20,doe21}. Next we`, kind: 'exact' });
});

test('inline math matches the letters and digits PDF.js extracts from it', () => {
  const src = String.raw`where $x_i \in \mathbb{R}^n$ denotes the input` + '\n';
  assert.deepEqual(find(src, 'where xi \u2208 Rn denotes'), { text: String.raw`where $x_i \in \mathbb{R}^n$ denotes`, kind: 'exact' });
});

test('TeX comments in the source do not break a match across lines', () => {
  const src = 'The first part % a remark that does not print\ncontinues here.\n';
  assert.deepEqual(find(src, 'first part continues', 1, 2), { text: 'first part % a remark that does not print\ncontinues', kind: 'exact' });
});

test('of two equal passages, the one at the SyncTeX line wins', () => {
  const src = 'a repeated phrase\nfiller\nfiller\nfiller\nfiller\nfiller\na repeated phrase\n';
  const m = matchPdfSelection(src, 'repeated phrase', 7, 7);
  assert.equal(m.kind, 'exact');
  assert.equal(src.slice(0, m.from).split('\n').length, 7);
});

test('a printed reference number falls back to a fuzzy match', () => {
  const src = String.raw`As Section~\ref{sec:method} shows, the model converges.` + '\n';
  assert.deepEqual(find(src, 'Section 3 shows, the model'), { text: String.raw`Section~\ref{sec:method} shows, the model`, kind: 'fuzzy' });
});

test('a long selection is matched at both ends', () => {
  const body = 'Weather station logs such as hourly rainfall, wind and other recorded values are stored today as tables or re-entered on demand.';
  const src = `\\section{Intro}\n${body.replace('hourly', '\\emph{hourly}')}\n`;
  const pdf = body.replace('stored', 'st0red').replace('on demand', 'on de-\nmand');
  assert.deepEqual(find(src, pdf, 2), { text: src.split('\n')[1], kind: 'fuzzy' });
});

test('text that is not in the source falls back to the whole lines', () => {
  const src = 'first line\n  second line  \nthird line\n';
  assert.deepEqual(find(src, 'zzzz qqqq', 2), { text: 'second line', kind: 'lines' });
  assert.deepEqual(find(src, '', 1, 3), { text: 'first line\n  second line  \nthird line', kind: 'lines' });
});

// ------------------------------------------------------- source to PDF

/**
 * Glyphs for printed lines, one glyph per character, 5 pt wide, 10 pt high,
 * lines 14 pt apart. A line may go to the next page with { page }.
 */
function printed(lines: Array<string | { page: number; text: string }>): PdfGlyph[] {
  const glyphs: PdfGlyph[] = [];
  let page = 1;
  let row = 0;
  for (const line of lines) {
    const text = typeof line === 'string' ? line : line.text;
    if (typeof line !== 'string' && line.page !== page) { page = line.page; row = 0; }
    [...text].forEach((ch, i) => {
      if (ch !== ' ') glyphs.push({ page, text: ch, x0: 100 + 5 * i, x1: 105 + 5 * i, top: 100 + 14 * row, bottom: 110 + 14 * row });
    });
    row++;
  }
  return glyphs;
}

/** The printed text a quote is matched to, and its kind. */
function shown(quote: string, glyphs: PdfGlyph[], near = 0): { text: string; kind: string } | null {
  const m = matchQuoteInPdf(quote, glyphs, near);
  return m && { text: glyphs.slice(m.first, m.last + 1).map((g) => g.text).join(''), kind: m.kind };
}

test('a whole \\item line is found without its bullet, up to its final period', () => {
  const glyphs = printed(['\u2022 Morning route: short-distance walk along the river, stops at', 'three bridges and a small village cel-', 'ebration, and steep descents.', '\u2022 Evening route: both school classes.']);
  const quote = String.raw`\item Morning route: short-distance walk along the river, stops at three bridges and a small village celebration, and steep descents.`;
  assert.deepEqual(shown(quote, glyphs), { text: 'Morningroute:short-distancewalkalongtheriver,stopsatthreebridgesandasmallvillagecel-ebration,andsteepdescents.', kind: 'exact' });
});

test('a mid-line quote covers only its own words', () => {
  const glyphs = printed(['Here comes quintessential photosynthesis again.']);
  assert.deepEqual(shown('quintessential photosynthesis', glyphs), { text: 'quintessentialphotosynthesis', kind: 'exact' });
  assert.deepEqual(shown(String.raw`(\emph{photosynthesis} again).`, printed(['Here (photosynthesis again). More'])), { text: '(photosynthesisagain).', kind: 'exact' });
});

test('markup, ligatures, accents and printed citations do not stop a match', () => {
  const glyphs = printed(['An e\uFB03cient \uFB01eld by K\u00F6hler [3, 4] works.']);
  assert.deepEqual(shown(String.raw`An \textbf{efficient} field by K\"ohler~\cite{a,b} works`, glyphs), { text: 'Ane\uFB03cient\uFB01eldbyK\u00F6hler[3,4]works', kind: 'exact' });
});

test('of two equal passages, the one nearest SyncTeX\'s glyph wins', () => {
  const glyphs = printed(['a repeated phrase here', 'filler', 'a repeated phrase there']);
  const second = glyphs.findIndex((g) => g.top === 128);
  const m = matchQuoteInPdf('repeated phrase', glyphs, second)!;
  assert.equal(glyphs[m.first].top, 128);
  assert.equal(matchQuoteInPdf('repeated phrase', glyphs, 0)!.first, 1);
});

test('a printed reference number is matched approximately', () => {
  const glyphs = printed(['As Section 3 shows, the model converges.']);
  assert.deepEqual(shown(String.raw`As Section~\ref{sec:method} shows, the model`, glyphs), { text: 'AsSection3shows,themodel', kind: 'fuzzy' });
});

test('a quote that prints nothing or is not there gives no match', () => {
  const glyphs = printed(['Some printed words.']);
  assert.equal(matchQuoteInPdf('% only a TeX comment', glyphs, 0), null);
  assert.equal(matchQuoteInPdf(String.raw`\label{x}`, glyphs, 0), null);
  assert.equal(matchQuoteInPdf('entirely different text here', glyphs, 0), null);
});

test('marks are one box per printed line, also across a page break', () => {
  const glyphs = printed(['first line of text', 'second line', { page: 2, text: 'third line on page two' }]);
  const m = matchQuoteInPdf('line of text second line third line', glyphs, 0)!;
  assert.deepEqual(glyphRects(glyphs, m.first, m.last), [
    { page: 1, x: 130, y: 100, width: 60, height: 10 },
    { page: 1, x: 100, y: 114, width: 55, height: 10 },
    { page: 2, x: 100, y: 100, width: 50, height: 10 },
  ]);
});

test('a superscript stays in its line\'s box, a second column starts a new one', () => {
  const glyphs: PdfGlyph[] = [
    { page: 1, text: 'a', x0: 10, x1: 15, top: 100, bottom: 110 },
    { page: 1, text: '1', x0: 15, x1: 18, top: 97, bottom: 104 },
    { page: 1, text: 'b', x0: 20, x1: 25, top: 100, bottom: 110 },
    { page: 1, text: 'c', x0: 300, x1: 305, top: 100, bottom: 110 },
  ];
  assert.deepEqual(glyphRects(glyphs, 0, 3), [
    { page: 1, x: 10, y: 97, width: 15, height: 13 },
    { page: 1, x: 300, y: 100, width: 5, height: 10 },
  ]);
});
