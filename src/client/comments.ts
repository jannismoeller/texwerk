import type * as Y from 'yjs';
import { allThreads, sortThreads, type CommentThread } from '@shared/comments.ts';
import { colorFor } from '@shared/files.ts';
import { mergeSeen, newestMessage, unreadMessages, type SeenThreads } from '@shared/readState.ts';
import { api, confirmDialog, copyText, formatTime, h, icon, toast } from './ui.ts';

/**
 * Comment threads in the browser: the list (the Comments tab), a thread
 * popover anchored in the editor or on the PDF, and the composer for a new
 * comment. Threads come from the project's Y.Doc, so everything here updates
 * live; every change goes through /api/comments, so view-only people can
 * comment too.
 */

export interface CommentsOptions {
  project: () => string;
  doc: Y.Doc;
  me: () => { login: string; name: string };
  canModerate: () => boolean;
  /** Jump to a thread's text in the editor (opening the file). */
  reveal: (thread: CommentThread) => void;
  /** Bring the Comments tab to the front; `select` then highlights the card. */
  showList: () => void;
  /** Called whenever the set of threads changes. */
  onChange: () => void;
}

const SHOW_KEY = 'texwerk-show-comments';
const UNREAD_ONLY_KEY = 'texwerk-comments-unread-only';

export class Comments {
  readonly panel = h('div', { class: 'comments-view' });
  private readonly opts: CommentsOptions;
  private threads: CommentThread[] = [];
  private filter: 'open' | 'all' = 'open';
  /** List only threads with messages this name has not seen (remembered per browser). */
  private unreadOnly = false;
  private popover: HTMLElement | null = null;
  private popoverThread: string | null = null;
  private selected: string | null = null;
  /**
   * What this name has seen, from the server (null until it arrives: then
   * nothing counts as unread). It changes only by an explicit action: the
   * "mark as read" button of a thread, or "Mark all read".
   */
  private seen: SeenThreads | null = null;
  show = true;

  constructor(opts: CommentsOptions) {
    this.opts = opts;
    try { this.show = localStorage.getItem(SHOW_KEY) !== '0'; } catch { /* default on */ }
    try { this.unreadOnly = localStorage.getItem(UNREAD_ONLY_KEY) === '1'; } catch { /* default off */ }
    let queued = false;
    opts.doc.getMap('comments').observeDeep(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; this.refresh(); });
    });
    // Anchors move as people type; the list's line numbers follow lazily.
    let textQueued: number | undefined;
    opts.doc.getMap('text').observeDeep(() => {
      window.clearTimeout(textQueued);
      textQueued = window.setTimeout(() => { if (this.threads.length) this.refresh(); }, 400);
    });
    document.addEventListener('mousedown', (e) => {
      // A click in commented text decides itself (CodeEditor's click handler):
      // it switches to that thread, or closes the popover after a drag.
      if (this.popover && !this.popover.contains(e.target as Node) && !(e.target as HTMLElement).closest('.cm-comment-marker, .pdf-pin, .pdf-comment-mark, .cm-comment-tip, .cm-comment-range')) this.closePopover();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.popover && !document.querySelector('.backdrop')) this.closePopover(); });
    // After the constructor returns: onChange may use the instance.
    queueMicrotask(() => this.refresh());
  }

  all(): CommentThread[] {
    return this.threads;
  }

  /** A thread by id, also right after the document arrived (before the list caught up). */
  find(id: string): CommentThread | undefined {
    if (!this.threads.some((t) => t.id === id)) this.refresh();
    return this.threads.find((t) => t.id === id);
  }

  /** The address that opens the project at this thread (`?comment=`). */
  link(id: string): string {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set('project', this.opts.project());
    url.searchParams.set('comment', id);
    return url.href;
  }

  /** Open threads with text still attached — what the editor and PDF show. */
  visible(path?: string): CommentThread[] {
    if (!this.show) return [];
    return this.threads.filter((t) => !t.resolved && t.from !== null && (!path || t.path === path));
  }

  get openCount(): number {
    return this.threads.filter((t) => !t.resolved).length;
  }

  // ------------------------------------------------------------ read state

  /** The server's read state for this name (src/shared/readState.ts). */
  setReadState(threads: SeenThreads): void {
    this.seen = threads;
    this.refresh();
  }

  private unread(t: CommentThread): number {
    return unreadMessages(t, this.seen, this.opts.me().login).length;
  }

  isUnread(id: string): boolean {
    const t = this.threads.find((x) => x.id === id);
    return Boolean(t && this.unread(t));
  }

  /** Threads with messages by others this name has not seen. */
  get unreadCount(): number {
    return this.threads.filter((t) => this.unread(t)).length;
  }

  /** The thread's "mark as read" button: all of it is seen now. */
  markRead(id: string): void {
    const t = this.threads.find((x) => x.id === id);
    if (!t || !this.seen) return;
    const newest = newestMessage(t);
    if (newest <= (this.seen[id] ?? 0)) return;
    this.saveSeen({ seen: { [id]: newest } }, { [id]: newest });
  }

  markAllRead(): void {
    if (!this.seen) return;
    this.saveSeen({ all: true }, Object.fromEntries(this.threads.map((t) => [t.id, newestMessage(t)])));
  }

  /** Show the change at once; the server's answer (also sent to this name's other tabs) settles it. */
  private saveSeen(body: Record<string, unknown>, local: SeenThreads): void {
    this.seen = mergeSeen(this.seen ?? {}, local).merged;
    this.refresh();
    api<{ threads: SeenThreads }>('POST', `/api/comments/read?project=${encodeURIComponent(this.opts.project())}`, body)
      .then((r) => { this.seen = mergeSeen(this.seen ?? {}, r.threads).merged; this.refresh(); })
      .catch(() => { /* the next readState event brings it back in line */ });
  }

  setShow(show: boolean): void {
    this.show = show;
    try { localStorage.setItem(SHOW_KEY, show ? '1' : '0'); } catch { /* ignore */ }
    this.renderPanel();
    this.opts.onChange();
  }

  private refresh(): void {
    this.threads = sortThreads(allThreads(this.opts.doc));
    this.renderPanel();
    if (this.popoverThread) {
      const t = this.threads.find((x) => x.id === this.popoverThread);
      if (t) this.popover?.replaceChildren(...this.threadBody(t, true));
      else this.closePopover();
    }
    this.opts.onChange();
  }

  private async act(body: Record<string, unknown>): Promise<boolean> {
    try {
      await api('POST', `/api/comments?project=${encodeURIComponent(this.opts.project())}`, body);
      return true;
    } catch (err) {
      toast((err as Error).message, 'bad');
      return false;
    }
  }

  // ------------------------------------------------------------ one thread

  private threadBody(t: CommentThread, inPopover: boolean): Node[] {
    const me = this.opts.me();
    const unread = new Set(unreadMessages(t, this.seen, me.login).map((m) => m.id));
    const markRead = unread.size
      ? h('button', { class: 'ghost icon mark-read', title: 'Mark this thread as read', 'aria-label': 'Mark this thread as read', onclick: (e: Event) => {
        e.stopPropagation();
        this.markRead(t.id);
      } }, icon('read'))
      : '';
    const head = h('div', { class: 'thread-head' },
      h('span', { class: 'thread-where', title: 'Go to the text' },
        t.from === null ? `${t.path} · text deleted` : `${t.path}:${t.line}`),
      h('span', { class: 'spacer' }),
      inPopover
        ? h('button', { class: 'ghost icon', title: 'Show this thread in the Comments tab', onclick: (e: Event) => {
          e.stopPropagation();
          this.closePopover();
          this.opts.showList();
          this.select(t.id);
        } }, 'In list')
        : '',
      h('button', { class: 'ghost icon', title: 'Copy a link that opens this comment — for anyone who has access to the project', onclick: (e: Event) => {
        e.stopPropagation();
        const link = this.link(t.id);
        void copyText(link).then(() => toast('Link to this comment copied', 'ok', 1500), () => toast(link));
      } }, 'Link'),
      markRead,
      t.resolved
        ? h('button', { class: 'ghost icon', title: 'Reopen this thread', onclick: () => void this.act({ op: 'reopen', id: t.id }) }, 'Reopen')
        : h('button', { class: 'ghost icon', title: 'Mark as resolved: hidden from the editor and PDF, kept in the list', onclick: () => void this.act({ op: 'resolve', id: t.id }).then((ok) => { if (ok && inPopover) this.closePopover(); }) }, '✓ Resolve'));
    head.querySelector('.thread-where')!.addEventListener('click', (e) => { e.stopPropagation(); this.opts.reveal(t); });
    const quote = h('div', { class: 'thread-quote', title: t.quote }, t.quote.length > 160 ? `${t.quote.slice(0, 160)}…` : t.quote);
    const messages = t.messages.map((m, i) => {
      const mine = m.login === me.login;
      const text = h('div', { class: 'msg-text' }, m.text);
      const tools = h('span', { class: 'msg-tools' });
      if (mine) {
        tools.append(h('button', { class: 'ghost icon', title: 'Edit', onclick: () => this.editMessage(t, m.id, m.text, text) }, 'edit'));
      }
      if (mine || this.opts.canModerate()) {
        tools.append(h('button', { class: 'ghost icon', title: i === 0 ? 'Delete the whole thread' : 'Delete this reply', onclick: async () => {
          const sure = i === 0
            ? await confirmDialog('Delete thread', 'Delete this comment and all its replies?', 'Delete', true)
            : await confirmDialog('Delete reply', 'Delete this reply?', 'Delete', true);
          if (!sure) return;
          void this.act({ op: 'delete', id: t.id, messageId: m.id });
        } }, 'delete'));
      }
      const isNew = unread.has(m.id);
      return h('div', { class: `msg${isNew ? ' unread' : ''}` },
        h('div', { class: 'msg-head' },
          h('span', { class: 'msg-dot', style: `background:${colorFor(m.login.replace(/:agent$/, ''))}` }),
          h('span', { class: 'msg-author' }, m.author),
          h('span', { class: 'msg-time', title: new Date(m.ts).toLocaleString() }, `${formatTime(m.ts)}${m.edited ? ' · edited' : ''}`),
          h('span', { class: 'spacer' }), tools),
        text);
    });
    const reply = h('textarea', { class: 'reply-box', rows: '1', placeholder: t.resolved ? 'Reply (reopens the thread)…' : 'Reply…' });
    const send = h('button', { class: 'primary', hidden: true }, 'Reply');
    const submit = async () => {
      const text = reply.value.trim();
      if (!text) return;
      send.disabled = true;
      if (await this.act({ op: 'reply', id: t.id, text })) reply.value = '';
      send.disabled = false;
    };
    reply.addEventListener('input', () => { send.hidden = !reply.value.trim(); reply.style.height = 'auto'; reply.style.height = `${Math.min(160, reply.scrollHeight)}px`; });
    reply.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } e.stopPropagation(); });
    reply.addEventListener('click', (e) => e.stopPropagation());
    send.addEventListener('click', (e) => { e.stopPropagation(); void submit(); });
    return [head, quote, ...messages, h('div', { class: 'reply-row' }, reply, send)];
  }

  private editMessage(t: CommentThread, messageId: string, current: string, textEl: HTMLElement): void {
    const box = h('textarea', { class: 'reply-box', rows: '3' });
    box.value = current;
    const save = h('button', { class: 'primary' }, 'Save');
    const cancel = h('button', {}, 'Cancel');
    const row = h('div', { class: 'reply-row' }, box, cancel, save);
    textEl.replaceWith(row);
    box.focus();
    box.addEventListener('keydown', (e) => e.stopPropagation());
    cancel.addEventListener('click', () => row.replaceWith(textEl));
    save.addEventListener('click', () => void this.act({ op: 'edit', id: t.id, messageId, text: box.value }));
  }

  // ------------------------------------------------------------ popover

  /**
   * Show a thread to the right of `rect` (the clicked commented text, a
   * gutter bubble or a PDF pin). The focus stays where it is; the reply box
   * takes it when clicked.
   */
  openThread(id: string, rect: DOMRect): void {
    const t = this.threads.find((x) => x.id === id);
    if (!t) return;
    this.select(id);
    // The same thread again (another line of it): move it, keeping a reply being typed.
    if (this.popoverThread === id && this.popover) { this.position(this.popover, rect, 'beside'); return; }
    this.popoverThread = id;
    this.placePopover(this.threadBody(t, true), rect);
  }

  /** Go to a thread's text in the source. */
  reveal(id: string): void {
    const t = this.threads.find((x) => x.id === id);
    if (t) this.opts.reveal(t);
  }

  /**
   * The composer for a new comment on [from, to) of `path`, beside `rect`
   * (or below or above it, with placement 'line'). `note` says something
   * about the anchor, such as that it could only be approximated.
   */
  compose(path: string, from: number, to: number, quote: string, rect: DOMRect, onDone: () => void, opts: { placement?: 'beside' | 'line'; note?: string } = {}): void {
    this.popoverThread = null;
    const box = h('textarea', { class: 'reply-box', rows: '3', placeholder: 'Add a comment…' });
    const post = h('button', { class: 'primary' }, 'Comment');
    const cancel = h('button', {}, 'Cancel');
    const submit = async () => {
      const text = box.value.trim();
      if (!text) { box.focus(); return; }
      post.disabled = true;
      if (await this.act({ op: 'create', path, from, to, text })) { this.closePopover(); onDone(); }
      post.disabled = false;
    };
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } e.stopPropagation(); });
    post.addEventListener('click', () => void submit());
    cancel.addEventListener('click', () => { this.closePopover(); onDone(); });
    this.placePopover([
      h('div', { class: 'thread-head' }, h('span', { class: 'thread-where' }, 'New comment')),
      h('div', { class: 'thread-quote' }, quote.length > 160 ? `${quote.slice(0, 160)}…` : quote),
      ...(opts.note ? [h('div', { class: 'compose-note' }, opts.note)] : []),
      box,
      h('div', { class: 'actions' }, cancel, post),
    ], rect, opts.placement);
    box.focus();
  }

  private placePopover(content: Node[], rect: DOMRect, placement: 'beside' | 'line' = 'beside'): void {
    this.popover?.remove();
    const pop = h('div', { class: 'comment-popover' }, ...content);
    document.body.append(pop);
    this.position(pop, rect, placement);
    this.popover = pop;
  }

  private position(pop: HTMLElement, rect: DOMRect, placement: 'beside' | 'line'): void {
    pop.style.maxHeight = '';
    const width = pop.offsetWidth;
    if (placement === 'line') {
      // Below the line, else above it, else on the side with more room
      // (shorter, scrolling): never over the line itself.
      const minTop = 46;
      const maxBottom = window.innerHeight - 30;
      const below = maxBottom - (rect.bottom + 6);
      const above = rect.top - 6 - minTop;
      const height = pop.offsetHeight;
      const left = Math.max(8, Math.min(rect.left - 24, window.innerWidth - width - 8));
      pop.style.left = `${left}px`;
      if (height <= below || below >= above) {
        pop.style.top = `${rect.bottom + 6}px`;
        if (height > below) pop.style.maxHeight = `${Math.max(120, below)}px`;
      } else {
        pop.style.top = `${Math.max(minTop, rect.top - 6 - height)}px`;
        if (height > above) pop.style.maxHeight = `${above}px`;
      }
    } else {
      const left = Math.max(8, Math.min(rect.right + 10, window.innerWidth - width - 8));
      const top = Math.max(46, Math.min(rect.top - 8, window.innerHeight - pop.offsetHeight - 30));
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    }
  }

  closePopover(): void {
    this.popover?.remove();
    this.popover = null;
    this.popoverThread = null;
  }

  // ------------------------------------------------------------ list

  select(id: string | null): void {
    this.selected = id;
    // A resolved thread is only in the list when it shows all threads.
    if (id && this.filter === 'open' && this.threads.find((t) => t.id === id)?.resolved) {
      this.filter = 'all';
      this.renderPanel();
    }
    this.panel.querySelectorAll('.thread-card').forEach((c) => c.classList.toggle('selected', (c as HTMLElement).dataset.id === id));
    if (id) this.panel.querySelector(`.thread-card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  private renderPanel(): void {
    const open = this.threads.filter((t) => !t.resolved);
    const resolved = this.threads.filter((t) => t.resolved);
    const toggle = h('label', { class: 'comments-toggle', title: 'Show comment highlights in the editor and pins in the PDF' },
      h('input', { type: 'checkbox', checked: this.show }), 'show in editor & PDF');
    toggle.querySelector('input')!.addEventListener('change', (e) => this.setShow((e.target as HTMLInputElement).checked));
    const filter = h('select', { title: 'Which threads to list' },
      h('option', { value: 'open', selected: this.filter === 'open' }, `Open (${open.length})`),
      h('option', { value: 'all', selected: this.filter === 'all' }, `All (${this.threads.length})`));
    filter.addEventListener('change', () => { this.filter = filter.value as 'open' | 'all'; this.renderPanel(); });
    const onlyUnread = h('label', { class: 'comments-toggle', title: 'List only threads with messages you have not seen' },
      h('input', { type: 'checkbox', checked: this.unreadOnly }), 'unread only');
    onlyUnread.querySelector('input')!.addEventListener('change', (e) => {
      this.unreadOnly = (e.target as HTMLInputElement).checked;
      try { localStorage.setItem(UNREAD_ONLY_KEY, this.unreadOnly ? '1' : '0'); } catch { /* this page only */ }
      this.renderPanel();
    });
    const cards: Node[] = [];
    let list = this.filter === 'open' ? open : [...open, ...resolved];
    if (this.unreadOnly) list = list.filter((t) => this.unread(t));
    if (!list.length) {
      cards.push(h('div', { class: 'comments-empty' },
        !this.threads.length ? 'No comments yet. Select text in the editor and press Comment (Ctrl+Alt+M).'
          : this.unreadOnly ? 'No unread comments.' : 'No open comments.'));
    }
    let resolvedHeading = false;
    for (const t of list) {
      if (t.resolved && !resolvedHeading) { cards.push(h('div', { class: 'comments-section' }, 'Resolved')); resolvedHeading = true; }
      const card = h('div', { class: `thread-card${t.resolved ? ' resolved' : ''}${t.id === this.selected ? ' selected' : ''}${this.unread(t) ? ' unread' : ''}`, 'data-id': t.id }, ...this.threadBody(t, false));
      card.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button, textarea, a')) return;
        this.select(t.id);
        this.opts.reveal(t);
      });
      cards.push(card);
    }
    const scroll = this.panel.querySelector('.comments-list')?.scrollTop ?? 0;
    // Keep a reply being typed across live updates.
    const typing = this.panel.contains(document.activeElement) && (document.activeElement as HTMLElement).classList.contains('reply-box');
    if (typing) return;
    const listEl = h('div', { class: 'comments-list' }, ...cards);
    const unread = this.unreadCount;
    const markAll = h('button', { class: 'ghost icon', title: 'Mark every thread as read', disabled: !unread }, 'Mark all read');
    markAll.addEventListener('click', async () => {
      const n = this.unreadCount;
      if (await confirmDialog('Mark all read', `Mark ${n} thread${n === 1 ? '' : 's'} with new messages as read?`, 'Mark all read')) this.markAllRead();
    });
    this.panel.replaceChildren(h('div', { class: 'comments-bar' }, filter, onlyUnread, markAll, h('span', { class: 'spacer' }), toggle), listEl);
    listEl.scrollTop = scroll;
  }
}
