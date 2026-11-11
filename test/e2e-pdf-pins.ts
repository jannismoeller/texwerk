/**
 * End-to-end check that comment pins and marks land on the commented words
 * in the PDF viewer.
 *
 *   node test/e2e-pdf-pins.ts <serverOrigin>        (CHROMIUM=/usr/bin/chromium by default)
 *
 * Needs a running server (with TeX) that this machine reaches without
 * tailnet headers (loopback counts as the admin). Creates a throwaway
 * project with known text, compiles it, comments on words in the middle of
 * paragraphs, across a line break, and on page 2, opens the editor in a
 * headless browser, and compares every pin's position with where pdf.js
 * itself says the word is printed.
 *
 * It then checks the marks over the commented text of a whole \item line, a
 * few words in the middle of a line and a paragraph across a page break
 * against the text layer: the marks cover the middle of every commented word
 * and of no word next to them, and their ends are within MARK_TOLERANCE_PT
 * of the first and last word's ends. The text layer spaces characters with a
 * browser font, so its words are themselves a few points off the glyphs.
 *
 * A comment on a TeX comment line, which prints nothing, has a pin level
 * with the nearest printed line and no mark. So has one on the preamble.
 *
 * Last, a double-click on a mark goes to the comment's text in the editor,
 * and its second click does nothing in the popup the first one opened. So
 * does a double-click on the pin of the TeX comment line.
 */
import { strict as assert } from 'node:assert';
import { chromium } from 'playwright-core';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const origin = process.argv[2] ?? 'http://127.0.0.1:5810';
const TOLERANCE_PT = 8;
const MARK_TOLERANCE_PT = 4;
const project = `pin-test-${Date.now().toString(36)}`;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${origin}${path}`, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`);
  return j;
};

const filler = 'This sentence is only here to fill the paragraph so that the lines wrap naturally across the page width. ';
const main = String.raw`\documentclass{article}
\begin{document}
First paragraph. ${filler.repeat(3)}Somewhere in the middle sits the word xylophone before more text. ${filler.repeat(2)}
% a TeX comment that is never printed
Second paragraph. ${filler.repeat(2)}Here comes quintessential photosynthesis again. ${filler.repeat(4)}
\begin{itemize}
  \item Morning route: short-distance walk along the river, stops at three bridges and a small village celebration, the old-town museum with its archives.
  \item Evening route: both school classes at the lake shore.
\end{itemize}
Long paragraph. ${filler.repeat(40)}It ends right here.
\newpage
Page two paragraph. ${filler.repeat(5)}Near the end we mention the zeppelin hangar once. ${filler}
\end{document}
`;

const targets = ['xylophone', 'quintessential photosynthesis', 'zeppelin hangar'];
const q = `?project=${encodeURIComponent(project)}`;
await api('POST', '/api/projects', { name: project, blank: true });
await api('PUT', `/api/file${q}&path=main.tex`, main);
await api('POST', `/api/settings${q}`, { mainFile: 'main.tex' });
const compiled = await api('POST', `/api/compile${q}&wait=1`);
assert.ok(compiled.compile.hasPdf, 'the test document compiles');
for (const quote of targets) await api('POST', `/api/comments${q}`, { op: 'create', path: 'main.tex', quote, text: `PIN ${quote}` });
await api('POST', `/api/comments${q}`, { op: 'create', path: 'main.tex', quote: '% a TeX comment that is never printed', text: 'PIN none' });
await api('POST', `/api/comments${q}`, { op: 'create', path: 'main.tex', quote: String.raw`\documentclass{article}`, text: 'PIN preamble' });
const itemLine = String.raw`\item Morning route: short-distance walk along the river, stops at three bridges and a small village celebration, the old-town museum with its archives.`;
const longParagraph = `Long paragraph. ${filler.repeat(40)}It ends right here.`;
const markCases = [
  { name: 'a whole \\item line', quote: itemLine, words: ['Morning', 'village', 'archives.'], outside: ['Evening'] },
  { name: 'words in the middle of a line', quote: 'quintessential photosynthesis', words: ['quintessential', 'photosynthesis'], outside: ['comes', 'again.'] },
  { name: 'a paragraph across a page break', quote: longParagraph, words: ['Long', 'paragraph.', 'ends', 'here.'], outside: [], pages: 2 },
];
const markIds = new Map<string, string>();
for (const c of markCases) markIds.set(c.name, (await api('POST', `/api/comments${q}`, { op: 'create', path: 'main.tex', quote: c.quote, text: `MARK ${c.name}` })).id);

// Where pdf.js says each target's first word starts, in PDF points from the page's top-left.
const pdfData = new Uint8Array(await (await fetch(`${origin}/pdf/${encodeURIComponent(project)}/x.pdf`)).arrayBuffer());
const doc = await getDocument({ data: pdfData }).promise;
const expected = new Map<string, { page: number; x: number; y: number }>();
for (let n = 1; n <= doc.numPages; n++) {
  const page = await doc.getPage(n);
  const height = page.getViewport({ scale: 1 }).height;
  for (const item of (await page.getTextContent()).items) {
    if (!('str' in item)) continue;
    for (const t of targets) {
      const word = t.split(' ')[0];
      const at = item.str.indexOf(word);
      if (at < 0 || expected.has(t)) continue;
      const size = Math.hypot(item.transform[2], item.transform[3]);
      expected.set(t, { page: n, x: item.transform[4] + (at / item.str.length) * item.width, y: height - item.transform[5] - size * 0.8 });
    }
  }
}
assert.equal(expected.size, targets.length, 'every target word is printed');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--no-sandbox'] });
let failed = false;
try {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  await page.addInitScript(() => localStorage.setItem('texwerk-name', 'Pin Test'));
  await page.goto(`${origin}/${q}`);
  await page.waitForFunction((n) => document.querySelectorAll('.pdf-pin').length >= n, targets.length, { timeout: 30_000 });
  await page.waitForTimeout(500);
  const pins = (await page.$$eval('.pdf-pin', (els) => els.map((el) => {
    const pageEl = el.parentElement as HTMLElement;
    const index = [...pageEl.parentElement!.children].indexOf(pageEl);
    const thread = (el as HTMLElement).dataset.thread;
    const markEl = pageEl.querySelector(`.pdf-comment-mark[data-thread="${thread}"]`) as HTMLElement | null;
    return {
      title: (el as HTMLElement).title, thread, page: index + 1, left: parseFloat(markEl?.style.left ?? 'NaN'), top: parseFloat(markEl?.style.top ?? 'NaN'),
      bubbleTop: (el as HTMLElement).offsetTop, markHeight: markEl?.offsetHeight ?? 0, pageWidthPx: pageEl.clientWidth,
      marks: document.querySelectorAll(`.pdf-comment-mark[data-thread="${thread}"]`).length,
    };
  }))).filter((p) => p.title.includes('PIN '));
  const pageWidthPt = (await (await doc.getPage(1)).getViewport({ scale: 1 })).width;
  assert.equal(pins.length, targets.length + 2, 'one pin per comment, the TeX comment and the preamble included');
  const preamble = pins.find((p) => p.title.includes('PIN preamble'))!;
  console.log(`${preamble.marks === 0 ? 'ok  ' : 'FAIL'} a comment on the preamble has a pin and no mark: ${preamble.marks} marks, pin on page ${preamble.page}`);
  if (preamble.marks !== 0) failed = true;
  // The TeX comment line: a pin level with the printed line SyncTeX gives for it (the next paragraph's first), and no mark.
  const silent = pins.find((p) => p.title.includes('PIN none'))!;
  for (const t of targets) {
    const pin = pins.find((p) => p.title.includes(`PIN ${t}`));
    const want = expected.get(t)!;
    assert.ok(pin, `a pin for "${t}"`);
    const scale = pin.pageWidthPx / pageWidthPt;
    const got = { page: pin.page, x: pin.left / scale, y: pin.top / scale };
    const dx = got.x - want.x;
    const dy = got.y - want.y;
    // The margin bubble must be level with the highlighted words.
    const level = Math.abs(pin.bubbleTop - pin.top) <= Math.max(14, pin.markHeight);
    const ok = got.page === want.page && Math.abs(dx) <= TOLERANCE_PT && Math.abs(dy) <= TOLERANCE_PT && level;
    console.log(`${ok ? 'ok  ' : 'FAIL'} "${t}": page ${got.page}/${want.page}, highlight off by ${dx.toFixed(1)} pt across, ${dy.toFixed(1)} pt down; margin bubble ${level ? 'level with it' : 'NOT level'}`);
    if (!ok) failed = true;
  }

  // Marks against the text layer. Draw every page's text layer first.
  for (let i = 0; i < doc.numPages; i++) {
    await page.evaluate((n) => document.querySelectorAll('.pdf-page')[n].scrollIntoView(), i);
    await page.waitForFunction((n) => document.querySelectorAll('.pdf-page')[n].querySelector('.textLayer span'), i, { timeout: 10_000 });
  }
  await page.waitForTimeout(300);
  const pxPerPt = await page.evaluate(() => (document.querySelector('.pdf-page') as HTMLElement).clientWidth) / pageWidthPt;
  const nextLine = await page.evaluate(() => {
    const span = [...document.querySelectorAll('.textLayer span')].find((s) => s.textContent!.includes('Second paragraph.'));
    return span ? (span as HTMLElement).getBoundingClientRect().top - span.closest('.pdf-page')!.getBoundingClientRect().top : null;
  });
  const silentOk = silent.marks === 0 && nextLine !== null && Math.abs(silent.bubbleTop - nextLine) <= 14;
  console.log(`${silentOk ? 'ok  ' : 'FAIL'} a comment on a TeX comment line has a pin and no mark: ${silent.marks} marks, pin at ${silent.bubbleTop} px, next printed line at ${nextLine === null ? 'not found' : `${nextLine.toFixed(0)} px`}`);
  if (!silentOk) failed = true;
  for (const c of markCases) {
    const id = markIds.get(c.name)!;
    const r = await page.evaluate(([id, words, outside, first]) => {
      type Box = { page: number; left: number; right: number; top: number; bottom: number };
      const pageOf = (el: Element) => [...document.querySelectorAll('.pdf-page')].indexOf(el.closest('.pdf-page')!) + 1;
      const box = (b: DOMRect, el: Element): Box => ({ page: pageOf(el), left: b.left, right: b.right, top: b.top, bottom: b.bottom });
      const marks = [...document.querySelectorAll(`.pdf-comment-mark[data-thread="${id}"]`)].map((m) => box(m.getBoundingClientRect(), m));
      const spans = [...document.querySelectorAll('.textLayer span')].filter((s) => s.firstChild?.nodeType === Node.TEXT_NODE);
      // Each word in the text layer, after the first word's span (words repeat in the filler).
      const start = spans.findIndex((s) => s.textContent!.includes(first));
      const find = (word: string): Box | null => {
        for (const s of spans.slice(start)) {
          const at = s.textContent!.search(new RegExp(`(^|\\s)${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`));
          if (at < 0) continue;
          const k = at + (s.textContent![at] === word[0] ? 0 : 1);
          const range = document.createRange();
          range.setStart(s.firstChild!, k);
          range.setEnd(s.firstChild!, k + word.length);
          return box(range.getBoundingClientRect(), s);
        }
        return null;
      };
      return { marks, words: words.map(find), outside: outside.map(find) };
    }, [id, c.words, c.outside, c.words[0]] as const);
    const covers = (w: { page: number; left: number; right: number; top: number; bottom: number }) => r.marks.some((m) =>
      m.page === w.page && (w.left + w.right) / 2 > m.left && (w.left + w.right) / 2 < m.right && (w.top + w.bottom) / 2 > m.top && (w.top + w.bottom) / 2 < m.bottom);
    const problems: string[] = [];
    if (!r.marks.length) problems.push('no marks');
    r.words.forEach((w, i) => { if (!w) problems.push(`"${c.words[i]}" not in the text layer`); else if (!covers(w)) problems.push(`"${c.words[i]}" not covered`); });
    r.outside.forEach((w, i) => { if (w && covers(w)) problems.push(`"${c.outside[i]}" covered`); });
    const firstWord = r.words[0];
    const lastWord = r.words[r.words.length - 1];
    const firstMark = r.marks[0];
    const lastMark = r.marks[r.marks.length - 1];
    let ends = '';
    if (firstWord && lastWord && firstMark && lastMark) {
      const dl = (firstMark.left - firstWord.left) / pxPerPt;
      const dr = (lastMark.right - lastWord.right) / pxPerPt;
      ends = `, start off by ${dl.toFixed(1)} pt, end by ${dr.toFixed(1)} pt`;
      if (Math.abs(dl) > MARK_TOLERANCE_PT || Math.abs(dr) > MARK_TOLERANCE_PT) problems.push('an end is off');
    }
    const pages = new Set(r.marks.map((m) => m.page)).size;
    if (pages !== (c.pages ?? 1)) problems.push(`marks on ${pages} pages`);
    console.log(`${problems.length ? 'FAIL' : 'ok  '} marks of ${c.name}: ${r.marks.length} boxes on ${pages} page(s)${ends}${problems.length ? `: ${problems.join(', ')}` : ''}`);
    if (problems.length) failed = true;
  }
  // A double-click on a comment's mark jumps to the comment's text in the source.
  const before = await page.evaluate(() => document.querySelector('.cm-activeLine')?.textContent ?? '');
  await page.locator(`.pdf-comment-mark[data-thread="${markIds.get('words in the middle of a line')}"]`).first().dblclick();
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => document.querySelector('.cm-activeLine')?.textContent ?? '');
  // The first click opened the popup, which can lie over the mark: the second click must not act in it (Resolve, Link).
  const id = markIds.get('words in the middle of a line')!;
  const kept = await page.evaluate((i) => Boolean(document.querySelector('.comment-popover')) && document.querySelectorAll(`.pdf-comment-mark[data-thread="${i}"]`).length > 0, id);
  const jumped = !before.includes('quintessential') && after.includes('quintessential') && kept;
  console.log(`${jumped ? 'ok  ' : 'FAIL'} a double-click on a comment mark goes to its text${jumped ? '' : `: line before ${JSON.stringify(before.slice(0, 40))}, after ${JSON.stringify(after.slice(0, 40))}, popup and mark kept ${kept}`}`);
  if (!jumped) failed = true;
  // The same for the pin of the comment on the TeX comment line.
  await page.keyboard.press('Escape');
  await page.locator(`.pdf-pin[data-thread="${silent.thread}"]`).dblclick();
  await page.waitForTimeout(800);
  const atComment = await page.evaluate(() => document.querySelector('.cm-activeLine')?.textContent ?? '');
  const pinJumped = atComment.includes('a TeX comment that is never printed');
  console.log(`${pinJumped ? 'ok  ' : 'FAIL'} a double-click on the pin of a TeX comment line goes to that line${pinJumped ? '' : `: line ${JSON.stringify(atComment.slice(0, 40))}`}`);
  if (!pinJumped) failed = true;
} finally {
  await browser.close();
}
if (failed) process.exit(1);
console.log('all pins and marks on their words');
