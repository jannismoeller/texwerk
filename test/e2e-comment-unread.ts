/**
 * Unread comments in a real browser against a running server:
 *
 *   node test/e2e-comment-unread.ts <serverOrigin>   (CHROMIUM=/usr/bin/chromium by default)
 *
 * Creates a throwaway project with a comment by Bob, then opens it as Ann:
 * - Ann's first visit starts with everything read;
 * - Bob's new comment and his reply make two threads unread (count on the
 *   Comments tab, marked cards and messages, dots on the gutter bubbles),
 *   Ann's own reply does not;
 * - selecting a thread in the list reads it;
 * - a second browser of Ann's sees the same state, and its "Mark all read"
 *   reaches the first one;
 * - another name has its own state, and opening the popup reads a thread.
 */
import { strict as assert } from 'node:assert';
import { chromium, type Page } from 'playwright-core';

const origin = process.argv[2] ?? 'http://127.0.0.1:5810';
const project = `unread-test-${Date.now().toString(36)}`;
const q = `?project=${encodeURIComponent(project)}`;
const api = async (method: string, path: string, body?: unknown, name = 'Bob') => {
  const r = await fetch(`${origin}${path}${path.includes('?') ? '&' : '?'}name=${name}`, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`);
  return j;
};
await api('POST', '/api/projects', { name: project, blank: true });
await api('PUT', `/api/file${q}&path=main.tex`, 'First line of text.\nSecond line of text.\nThird line of text.\n');
const old = (await api('POST', `/api/comments${q}`, { op: 'create', path: 'main.tex', quote: 'First line', text: 'Old comment by Bob' })).id;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--no-sandbox'] });
async function open(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => { localStorage.setItem('texwerk-name', 'Ann'); localStorage.setItem('texwerk-side-panel', JSON.stringify({ tab: 'comments' })); });
  await page.goto(`${origin}/${q}&file=main.tex`);
  await page.waitForSelector('.thread-card', { timeout: 20000 });
  await page.waitForTimeout(800);
  return page;
}
const state = (page: Page) => page.evaluate(() => ({
  badge: document.querySelector('.side-tabs .count.unread')?.textContent ?? '0',
  unreadCards: [...document.querySelectorAll('.thread-card.unread')].map((c) => (c as HTMLElement).dataset.id),
  newMsgs: [...document.querySelectorAll('.thread-card .msg.unread .msg-text')].map((m) => m.textContent),
  gutterDots: document.querySelectorAll('.cm-comment-marker.unread').length,
  markAllDisabled: (([...document.querySelectorAll('.comments-bar button')].find((b) => b.textContent === 'Mark all read') as HTMLButtonElement | undefined)?.disabled),
}));
const a = await open();
let failed = false;
const check = (name: string, got: unknown, want: unknown) => {
  try { assert.deepEqual(got, want); console.log(`ok   ${name}`); } catch { failed = true; console.log(`FAIL ${name}: ${JSON.stringify(got)}`); }
};
try {
check('a first visit starts with everything read', await state(a), { badge: '0', unreadCards: [], newMsgs: [], gutterDots: 0, markAllDisabled: true });
const fresh = (await api('POST', `/api/comments${q}`, { op: 'create', path: 'main.tex', quote: 'Second line', text: 'New comment by Bob' })).id;
await api('POST', `/api/comments${q}`, { op: 'reply', id: old, text: 'Reply by Bob' });
await api('POST', `/api/comments${q}`, { op: 'reply', id: fresh, text: 'Own reply by Ann' }, 'Ann');
await a.waitForTimeout(800);
check('new messages by others are unread, own ones are not', await state(a), { badge: '2', unreadCards: [old, fresh], newMsgs: ['Reply by Bob', 'New comment by Bob'], gutterDots: 2, markAllDisabled: false });
await a.click(`.thread-card[data-id="${old}"] .msg-text >> nth=0`);
await a.waitForTimeout(800);
check('selecting a thread reads it, its new messages stay marked while selected', await state(a), { badge: '1', unreadCards: [fresh], newMsgs: ['Reply by Bob', 'New comment by Bob'], gutterDots: 1, markAllDisabled: false });
const b = await open();
check('a second browser of the same name has the same state', await state(b), { badge: '1', unreadCards: [fresh], newMsgs: ['New comment by Bob'], gutterDots: 1, markAllDisabled: false });
await b.click('.comments-bar button:has-text("Mark all read")');
await a.waitForTimeout(1000);
check('Mark all read in one browser reaches the other', await state(a), { badge: '0', unreadCards: [], newMsgs: ['Reply by Bob'], gutterDots: 0, markAllDisabled: true });
const c = await (async () => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => { localStorage.setItem('texwerk-name', 'Carl'); localStorage.setItem('texwerk-side-panel', JSON.stringify({ tab: 'comments' })); });
  await page.goto(`${origin}/${q}&file=main.tex`);
  await page.waitForSelector('.thread-card', { timeout: 20000 });
  await page.waitForTimeout(800);
  return page;
})();
await api('POST', `/api/comments${q}`, { op: 'reply', id: old, text: 'Bob again' });
await c.waitForTimeout(800);
check('another name has its own state', await state(c), { badge: '1', unreadCards: [old], newMsgs: ['Bob again'], gutterDots: 1, markAllDisabled: false });
// Popup opening marks read.
await c.evaluate(() => (document.querySelector('.cm-comment-marker') as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
await c.waitForTimeout(800);
check('opening the popup reads the thread and marks its new message', [await state(c), await c.evaluate(() => [...document.querySelectorAll('.comment-popover .msg.unread .msg-text')].map((m) => m.textContent))], [{ badge: '0', unreadCards: [], newMsgs: ['Bob again'], gutterDots: 0, markAllDisabled: true }, ['Bob again']]);
} finally {
  await browser.close();
  await api('POST', `/api/projects/delete${q}`).catch(() => undefined);
}
process.exit(failed ? 1 : 0);
