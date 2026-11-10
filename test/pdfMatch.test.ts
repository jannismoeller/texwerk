import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { matchPdfSelection, pdfSkeleton, sourceSkeleton } from '../src/shared/pdfMatch.ts';

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
