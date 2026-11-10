/**
 * Find the LaTeX source of text selected in the compiled PDF.
 *
 * SyncTeX maps a point in the PDF to a source line, not to a column. So the
 * caller asks SyncTeX for the lines of the selection's start and end, and
 * this module finds the selected words inside those lines. PDF text differs
 * from its source: ligatures (U+FB01 for "fi"), words hyphenated across
 * lines, collapsed spaces, accents typed as \"o, and markup that prints
 * nothing (\emph, comments, \label) or prints something else (\cite becomes
 * "[3]"). Both sides are therefore reduced to a "skeleton" of lower-case
 * ASCII letters and digits, with every skeleton character remembering where
 * in the source it came from. Matching the skeletons ignores spaces, hyphens,
 * punctuation and markup.
 *
 * The result is exact (the selection's skeleton occurs in the source),
 * fuzzy (the best approximate match, within a small edit distance), or the
 * whole line range when neither works.
 */

export type MatchKind = 'exact' | 'fuzzy' | 'lines';

export interface SourceMatch {
  /** Character offsets into the source, [from, to). */
  from: number;
  to: number;
  kind: MatchKind;
}

/** Lines around SyncTeX's answer that are searched as well; SyncTeX is often a line off. */
const LINE_SLACK = 2;
/** Characters of the selection's skeleton matched at each end of a long selection. */
const END_LENGTH = 48;

// Commands whose arguments print nothing, or print something unrelated to
// their source text (a number, a citation label), with how many mandatory
// arguments to skip.
const DROP_ARGS: Record<string, number> = {
  cite: 1, citep: 1, citet: 1, citealp: 1, citealt: 1, parencite: 1, autocite: 1, footcite: 1, supercite: 1, nocite: 1,
  ref: 1, eqref: 1, autoref: 1, cref: 1, Cref: 1, pageref: 1, nameref: 1, vref: 1,
  label: 1, input: 1, include: 1, includegraphics: 1, usepackage: 1, documentclass: 1,
  bibliography: 1, bibliographystyle: 1, addbibresource: 1, begin: 1, end: 1,
  hspace: 1, vspace: 1, color: 1, textcolor: 1, href: 1, setlength: 2, addtolength: 2,
};

const FOLD: Record<string, string> = { 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'ł': 'l', 'đ': 'd', 'ı': 'i', 'ð': 'd', 'þ': 'th' };

/** A character as skeleton characters: ligatures expanded, accents and case dropped, only [a-z0-9] kept. */
function fold(ch: string): string {
  const s = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return s.replace(/[ßæœøłđıðþ]/g, (m) => FOLD[m]).replace(/[^a-z0-9]/g, '');
}

interface Skeleton {
  text: string;
  /** Source offset of each skeleton character, and the offset just after it. */
  from: number[];
  to: number[];
}

/** Skip one balanced group starting at `open` (a `{` or `[`); returns the offset after it. */
function skipGroup(src: string, open: number, end: number): number {
  const opener = src[open];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  for (let i = open; i < end; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === opener) depth++;
    else if (c === closer && --depth === 0) return i + 1;
  }
  return end;
}

/** Skip spaces and at most one line break. */
function skipSpace(src: string, i: number, end: number): number {
  let breaks = 0;
  while (i < end && /\s/.test(src[i])) {
    if (src[i] === '\n' && ++breaks > 1) break;
    i++;
  }
  return i;
}

/** The skeleton of source[start, end): what would print, as letters and digits. */
export function sourceSkeleton(src: string, start = 0, end = src.length): Skeleton {
  const out: Skeleton = { text: '', from: [], to: [] };
  let i = start;
  while (i < end) {
    const c = src[i];
    if (c === '%') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 || nl > end ? end : nl + 1;
      continue;
    }
    if (c === '\\') {
      const next = src[i + 1] ?? '';
      if (/[a-zA-Z@]/.test(next)) {
        let j = i + 1;
        while (j < end && /[a-zA-Z@]/.test(src[j])) j++;
        const name = src.slice(i + 1, j);
        if (src[j] === '*') j++;
        let drop = DROP_ARGS[name] ?? 0;
        while (drop > 0) {
          let k = skipSpace(src, j, end);
          while (src[k] === '[') k = skipSpace(src, skipGroup(src, k, end), end);
          if (src[k] !== '{') break;
          j = skipGroup(src, k, end);
          drop--;
        }
        i = j;
      } else {
        // A control symbol (\' \" \% \\ ...); \\ may carry a [length].
        i += 2;
        if (next === '\\') {
          const k = skipSpace(src, i, end);
          if (src[k] === '[') i = skipGroup(src, k, end);
        }
      }
      continue;
    }
    for (const f of fold(c)) {
      out.text += f;
      out.from.push(i);
      out.to.push(i + 1);
    }
    i++;
  }
  return out;
}

/** Numeric citations as the PDF prints them: [3], [3, 4], [12-15]. */
const PRINTED_CITATION = /\[\s*\d+(?:\s*[,–—-]\s*\d+)*\s*\]/g;

/** The skeleton of the selected PDF text. */
export function pdfSkeleton(text: string): string {
  return [...text.replace(PRINTED_CITATION, ' ')].map(fold).join('');
}

/** Approximate substring match (Sellers): the cheapest [start, end) of `s` that matches `p`. */
function fuzzyFind(p: string, s: string, near: number): { start: number; end: number; cost: number } | null {
  const m = p.length;
  if (!m || !s.length) return null;
  let prevCost = new Int32Array(m + 1);
  let prevStart = new Int32Array(m + 1);
  let curCost = new Int32Array(m + 1);
  let curStart = new Int32Array(m + 1);
  for (let i = 0; i <= m; i++) { prevCost[i] = i; prevStart[i] = 0; }
  let best: { start: number; end: number; cost: number } | null = null;
  for (let j = 1; j <= s.length; j++) {
    curCost[0] = 0;
    curStart[0] = j;
    const sc = s[j - 1];
    for (let i = 1; i <= m; i++) {
      let cost = prevCost[i - 1] + (p[i - 1] === sc ? 0 : 1);
      let start = prevStart[i - 1];
      if (prevCost[i] + 1 < cost) { cost = prevCost[i] + 1; start = prevStart[i]; }
      if (curCost[i - 1] + 1 < cost) { cost = curCost[i - 1] + 1; start = curStart[i - 1]; }
      curCost[i] = cost;
      curStart[i] = start;
    }
    const cost = curCost[m];
    const start = curStart[m];
    if (!best || cost < best.cost || (cost === best.cost && Math.abs(start - near) < Math.abs(best.start - near))) {
      best = { start, end: j, cost };
    }
    [prevCost, curCost] = [curCost, prevCost];
    [prevStart, curStart] = [curStart, prevStart];
  }
  return best;
}

/** How many edits a fuzzy match of `length` skeleton characters may need. */
function allowedCost(length: number): number {
  return Math.floor(length * 0.25) + 1;
}

/**
 * Where the skeleton `wanted` occurs in the skeleton `text`: exactly (the
 * occurrence nearest `near`), else approximately, the whole of a short one or
 * the two ends of a long one separately. [start, end) indexes `text`.
 */
function findSkeleton(wanted: string, text: string, near: number): { start: number; end: number; kind: 'exact' | 'fuzzy' } | null {
  if (!wanted.length) return null;
  let best = -1;
  for (let i = text.indexOf(wanted); i >= 0; i = text.indexOf(wanted, i + 1)) {
    if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
  }
  if (best >= 0) return { start: best, end: best + wanted.length, kind: 'exact' };
  if (wanted.length <= 2 * END_LENGTH) {
    const m = fuzzyFind(wanted, text, near);
    if (m && m.cost <= allowedCost(wanted.length) && m.end > m.start) return { start: m.start, end: m.end, kind: 'fuzzy' };
    return null;
  }
  const head = fuzzyFind(wanted.slice(0, END_LENGTH), text, near);
  if (!head || head.cost > allowedCost(END_LENGTH)) return null;
  const rest = text.slice(head.start);
  const tail = fuzzyFind(wanted.slice(-END_LENGTH), rest, wanted.length - END_LENGTH);
  if (tail && tail.cost <= allowedCost(END_LENGTH) && tail.end > 0) return { start: head.start, end: head.start + tail.end, kind: 'fuzzy' };
  return null;
}

function lineStarts(src: string): number[] {
  const starts = [0];
  for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/**
 * Where the text `selected` from the PDF sits in `source`, given the
 * 1-based source lines SyncTeX found for the selection's start and end.
 */
export function matchPdfSelection(source: string, selected: string, firstLine: number, lastLine: number): SourceMatch {
  const starts = lineStarts(source);
  const lines = starts.length;
  const clampLine = (n: number) => Math.max(1, Math.min(lines, Math.round(n) || 1));
  let lo = clampLine(Math.min(firstLine, lastLine));
  let hi = clampLine(Math.max(firstLine, lastLine));
  const lineEnd = (n: number) => (n < lines ? starts[n] - 1 : source.length);
  const winFrom = starts[Math.max(1, lo - LINE_SLACK) - 1];
  const winTo = lineEnd(Math.min(lines, hi + LINE_SLACK));
  const near = starts[lo - 1];

  const skeleton = sourceSkeleton(source, winFrom, winTo);
  const wanted = pdfSkeleton(selected);
  const nearIndex = Math.max(0, skeleton.from.findIndex((f) => f >= near));
  const result = (a: number, b: number, kind: MatchKind): SourceMatch => {
    const words = toWords(source, skeleton.from[a], skeleton.to[b - 1]);
    return { ...widen(source, selected, words.from, words.to), kind };
  };

  const found = findSkeleton(wanted, skeleton.text, nearIndex);
  if (found) return result(found.start, found.end, found.kind);

  // The whole lines, without their indentation and trailing spaces.
  let from = starts[lo - 1];
  let to = lineEnd(hi);
  while (from < to && /\s/.test(source[from])) from++;
  while (to > from && /\s/.test(source[to - 1])) to--;
  if (to <= from) {
    // Blank lines: widen to the nearest text.
    while (lo > 1 && to <= from) { lo--; from = starts[lo - 1]; to = lineEnd(hi); while (to > from && /\s/.test(source[to - 1])) to--; }
  }
  return { from, to, kind: 'lines' };
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Whole words at both ends. PDF.js's text layer spaces the characters of a
 * run with a browser font, so they can sit a few points off the printed
 * glyphs: a drag that starts on the first printed letter of a word can begin
 * the selection at the second one ("orning" for "Morning"), most of all after
 * a list bullet. A selection that starts or ends inside a word is therefore
 * taken to mean the whole word.
 */
function toWords(source: string, from: number, to: number): { from: number; to: number } {
  while (from > 0 && WORD_CHAR.test(source[from - 1]) && WORD_CHAR.test(source[from])) from--;
  while (to < source.length && WORD_CHAR.test(source[to]) && WORD_CHAR.test(source[to - 1])) to++;
  return { from, to };
}

/**
 * Take in what the skeleton leaves out at the ends of the selection: an
 * opening bracket or quote before it, punctuation after it, and a citation
 * command whose printed "[3]" ends the selection.
 */
function widen(source: string, selected: string, from: number, to: number): { from: number; to: number } {
  const trimmed = selected.trim();
  const lead = /^[(\[`'"‘“]*/.exec(trimmed)![0].length;
  for (let n = lead; n > 0 && from > 0 && /[(\[`'"]/.test(source[from - 1]); n--) from--;
  let tail = trimmed;
  const citation = /\[\s*\d+(?:\s*[,–—-]\s*\d+)*\s*\]([.,;:!?)'"’”]*)$/.exec(tail);
  if (citation) {
    const cite = /^[\s~]*\\(?:cite|citep|citet|citealp|citealt|parencite|autocite|supercite)\*?(?:\s*\[[^\]]*\])*\s*\{[^}]*\}/.exec(source.slice(to));
    if (cite) to += cite[0].length;
    tail = citation[1];
  } else {
    tail = /[.,;:!?)\]'"’”]*$/.exec(tail)![0];
  }
  for (let n = tail.length; n > 0 && /[.,;:!?)\]'"]/.test(source[to] ?? ''); n--) to++;
  return { from, to };
}

// ------------------------------------------------------- source to PDF

/** A printed glyph: its text and box in PDF points from the page's top-left. */
export interface PdfGlyph {
  page: number;
  text: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
}

/** A box on a page, in PDF points from the page's top-left. */
export interface PdfRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a source quote is printed: glyphs `first` to `last` (inclusive). */
export interface PdfQuoteMatch {
  first: number;
  last: number;
  kind: 'exact' | 'fuzzy';
}

const OPENING = /[(\[`'"‘“]/;
const CLOSING = /[.,;:!?)\]'"’”]/;

/**
 * Where the LaTeX `quote` is printed among `glyphs` (in reading order, as
 * the PDF draws them): the other direction of matchPdfSelection, with the
 * same skeletons. `near` is the glyph SyncTeX points at; of several equal
 * passages the nearest wins. Null when the quote prints nothing or is not
 * found.
 */
export function matchQuoteInPdf(quote: string, glyphs: ReadonlyArray<{ text: string }>, near: number): PdfQuoteMatch | null {
  const wanted = sourceSkeleton(quote).text;
  if (!wanted) return null;
  // The glyphs' text, each character remembering its glyph.
  let text = '';
  const owner: number[] = [];
  glyphs.forEach((g, i) => {
    text += g.text;
    for (let k = 0; k < g.text.length; k++) owner.push(i);
  });
  // Printed numeric citations have no counterpart in the source's skeleton.
  const dropped = new Uint8Array(text.length);
  for (const m of text.matchAll(PRINTED_CITATION)) dropped.fill(1, m.index!, m.index! + m[0].length);
  let skeleton = '';
  const skeletonGlyph: number[] = [];
  for (let k = 0; k < text.length; k++) {
    if (dropped[k]) continue;
    for (const f of fold(text[k])) {
      skeleton += f;
      skeletonGlyph.push(owner[k]);
    }
  }
  const nearIndex = Math.max(0, skeletonGlyph.findIndex((g) => g >= near));
  const found = findSkeleton(wanted, skeleton, nearIndex);
  if (!found) return null;
  let first = skeletonGlyph[found.start];
  let last = skeletonGlyph[found.end - 1];
  // Brackets, quotes and punctuation at the ends print but have no skeleton.
  const body = quote.trim().replace(/(?:\s|[{}]|%[^\n]*)+$/, '');
  const lead = /^(?:\\[a-zA-Z@]+\*?\s*|[{\s])*([(\[`'"]*)/.exec(body)?.[1].replace(/``|''/g, '"').length ?? 0;
  const tail = /[.,;:!?)\]'"]*$/.exec(body)![0].replace(/``|''/g, '"').length;
  for (let n = lead; n > 0 && first > 0 && OPENING.test(glyphs[first - 1].text); n--) first--;
  for (let n = tail; n > 0 && last + 1 < glyphs.length && CLOSING.test(glyphs[last + 1].text); n--) last++;
  return { first, last, kind: found.kind };
}

/**
 * One box per printed line of glyphs `first` to `last`, from the first
 * glyph on that line to the last. A new line starts on another page, when a
 * glyph sits vertically outside the current box, or when it moves back to
 * the left or far to the right (another column).
 */
export function glyphRects(glyphs: readonly PdfGlyph[], first: number, last: number): PdfRect[] {
  const rects: PdfRect[] = [];
  let cur: { page: number; x0: number; x1: number; top: number; bottom: number } | null = null;
  const flush = () => { if (cur) rects.push({ page: cur.page, x: cur.x0, y: cur.top, width: cur.x1 - cur.x0, height: cur.bottom - cur.top }); };
  for (let i = Math.max(0, first); i <= last && i < glyphs.length; i++) {
    const g = glyphs[i];
    if (g.x1 <= g.x0 && !g.text.trim()) continue;
    const mid = (g.top + g.bottom) / 2;
    const height = g.bottom - g.top;
    const sameLine = cur && cur.page === g.page && mid > cur.top && mid < cur.bottom
      && g.x0 > cur.x0 - 1 && g.x0 < cur.x1 + 3 * height;
    if (cur && sameLine) {
      cur.x1 = Math.max(cur.x1, g.x1);
      cur.top = Math.min(cur.top, g.top);
      cur.bottom = Math.max(cur.bottom, g.bottom);
    } else {
      flush();
      cur = { page: g.page, x0: g.x0, x1: g.x1, top: g.top, bottom: g.bottom };
    }
  }
  flush();
  return rects;
}
