/**
 * Starting a comment from text selected in the PDF, in a real browser
 * against a running server:
 *
 *   node test/e2e-pdf-comment.ts <serverOrigin>   (CHROMIUM=/usr/bin/chromium by default)
 *
 * Creates a throwaway project, compiles it, selects words in the PDF's text
 * layer, presses the Comment button that appears beside the selection,
 * posts the comment, and checks which source text the new thread is on:
 * - words with \emph markup and a numeric citation in between map exactly;
 * - a section heading, whose printed number is not in the source, maps
 *   approximately, and the composer says so;
 * - Ctrl+Alt+M with a PDF selection opens the composer too.
 */
import { strict as assert } from 'node:assert';
import { chromium, type Page } from 'playwright-core';

const origin = process.argv[2] ?? 'http://127.0.0.1:5810';
const project = `pdf-comment-test-${Date.now().toString(36)}`;
const q = `?project=${encodeURIComponent(project)}`;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${origin}${path}`, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`);
  return j;
};

const MAIN = String.raw`\documentclass{article}
\begin{document}
\section{Introduction}
Light fields are a \emph{strongly} studied topic in graphics~\cite{levoy96}.
% a remark that does not print
They record the efficient flow of radiance.

\begin{thebibliography}{9}
\bibitem{levoy96} M. Levoy and P. Hanrahan. Light field rendering. 1996.
\end{thebibliography}
\end{document}
`;

await api('POST', '/api/projects', { name: project, blank: true });
await api('PUT', `/api/file${q}&path=main.tex`, MAIN);
await api('POST', `/api/settings${q}`, { mainFile: 'main.tex', autoCompile: false });
const compiled = await api('POST', `/api/compile${q}&wait=1`);
assert.ok(compiled.compile.hasPdf, 'the document compiles');

let failed = false;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed = true; console.log(`FAIL ${name}\n${(e as Error).message}`); }
}

/** Select `from` .. `to` (inclusive) in the text layer, as a mouse drag would. */
async function selectInPdf(page: Page, from: string, to: string): Promise<string> {
  return page.evaluate(([a, b]) => {
    const spans = [...document.querySelectorAll('.textLayer span')].filter((s) => s.firstChild?.nodeType === Node.TEXT_NODE);
    const start = spans.find((s) => s.textContent!.includes(a))!;
    const end = spans.find((s) => s.textContent!.includes(b) && (s === start || start.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING))!;
    const range = document.createRange();
    range.setStart(start.firstChild!, start.textContent!.indexOf(a));
    range.setEnd(end.firstChild!, end.textContent!.indexOf(b) + b.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    document.querySelector('.pdf-pages')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return getSelection()!.toString();
  }, [from, to]);
}

async function postComment(page: Page, text: string): Promise<{ quote: string; note: string }> {
  await page.waitForSelector('.comment-popover textarea');
  const note = await page.locator('.comment-popover .compose-note').textContent().catch(() => '') ?? '';
  await page.locator('.comment-popover textarea').fill(text);
  await page.locator('.comment-popover button', { hasText: 'Comment' }).click();
  for (let i = 0; i < 50; i++) {
    const { threads } = await api('GET', `/api/comments${q}`);
    const t = threads.find((x: { messages: Array<{ text: string }> }) => x.messages[0]?.text === text);
    if (t) return { quote: t.quote, note };
    await page.waitForTimeout(100);
  }
  throw new Error('the comment was not created');
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.addInitScript(() => localStorage.setItem('texwerk-name', 'PDF Comment Test'));

try {
  await page.goto(`${origin}/${q}&file=main.tex`);
  await page.waitForSelector('.textLayer span', { timeout: 20000 });

  await check('words with \\emph and a citation map exactly', async () => {
    const selected = await selectInPdf(page, 'strongly', 'graphics [1].');
    assert.match(selected, /strongly studied topic in graphics \[1\]\./);
    await page.waitForSelector('.pdf-comment-tip');
    await page.locator('.pdf-comment-tip').dispatchEvent('mousedown');
    const { quote, note } = await postComment(page, 'first');
    assert.equal(quote, String.raw`strongly} studied topic in graphics~\cite{levoy96}.`);
    assert.equal(note, '');
  });

  await check('a ligature and a TeX comment between the lines map exactly (Ctrl+Alt+M)', async () => {
    await selectInPdf(page, 'graphics', 'efficient');
    await page.keyboard.press('Control+Alt+m');
    const { quote } = await postComment(page, 'second');
    assert.equal(quote, 'graphics~\\cite{levoy96}.\n% a remark that does not print\nThey record the efficient');
  });

  await check('a numbered heading maps approximately and says so', async () => {
    await selectInPdf(page, '1', 'Introduction');
    await page.locator('.pdf-comment-tip').dispatchEvent('mousedown');
    const { quote, note } = await postComment(page, 'third');
    assert.equal(quote, 'Introduction');
    assert.match(note, /approximately/);
  });
} finally {
  await browser.close();
  await api('POST', `/api/projects/delete${q}`).catch(() => undefined);
}
process.exit(failed ? 1 : 0);
