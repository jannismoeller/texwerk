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
  const result = (a: number, b: number, kind: MatchKind): SourceMatch =>
    ({ ...widen(source, selected, skeleton.from[a], skeleton.to[b - 1]), kind });

  if (wanted.length) {
    // Exact: the occurrence nearest the start line.
    let best = -1;
    for (let i = skeleton.text.indexOf(wanted); i >= 0; i = skeleton.text.indexOf(wanted, i + 1)) {
      if (best < 0 || Math.abs(i - nearIndex) < Math.abs(best - nearIndex)) best = i;
    }
    if (best >= 0) return result(best, best + wanted.length, 'exact');

    // Fuzzy: the whole selection when short, else its two ends separately.
    if (wanted.length <= 2 * END_LENGTH) {
      const m = fuzzyFind(wanted, skeleton.text, nearIndex);
      if (m && m.cost <= allowedCost(wanted.length) && m.end > m.start) return result(m.start, m.end, 'fuzzy');
    } else {
      const head = fuzzyFind(wanted.slice(0, END_LENGTH), skeleton.text, nearIndex);
      if (head && head.cost <= allowedCost(END_LENGTH)) {
        const rest = skeleton.text.slice(head.start);
        const tail = fuzzyFind(wanted.slice(-END_LENGTH), rest, wanted.length - END_LENGTH);
        if (tail && tail.cost <= allowedCost(END_LENGTH) && tail.end > 0) return result(head.start, head.start + tail.end, 'fuzzy');
      }
    }
  }

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
