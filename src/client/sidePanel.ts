import { h } from './ui.ts';

/**
 * The left-hand side panel: the file tree, the comment threads and the chat
 * as tabs, so the PDF on the right can stay in view next to any of them.
 * The whole panel can be hidden (toolbar button, Ctrl+Alt+B) to give the
 * editor and the PDF its width. The active tab and whether the panel shows
 * are remembered per browser.
 */

export type SideTab = 'files' | 'comments' | 'chat';

export interface SidePanelOptions {
  files: HTMLElement;
  comments: HTMLElement;
  chat: HTMLElement;
  /** The tab in front changed, or the panel was shown or hidden. */
  onChange: (tab: SideTab | null) => void;
}

const KEY = 'texwerk-side-panel';

export class SidePanel {
  readonly root = h('div', { class: 'pane side-pane' });
  private readonly tabs = h('div', { class: 'viewer-tabs side-tabs' });
  private readonly body = h('div', { class: 'side-body' });
  private readonly panels: Record<SideTab, HTMLElement>;
  private readonly opts: SidePanelOptions;
  private tab: SideTab = 'files';
  private hiddenNow = false;
  private commentCount = 0;
  private commentUnread = 0;
  private chatUnread = 0;
  private chatMentioned = false;

  constructor(opts: SidePanelOptions) {
    this.opts = opts;
    this.panels = { files: opts.files, comments: opts.comments, chat: opts.chat };
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { tab?: string; hidden?: boolean };
      if (saved.tab === 'files' || saved.tab === 'comments' || saved.tab === 'chat') this.tab = saved.tab;
      this.hiddenNow = saved.hidden === true;
    } catch { /* defaults */ }
    // All three stay in the DOM, so scroll positions and a reply being typed survive a tab switch.
    for (const [id, panel] of Object.entries(this.panels)) this.body.append(h('div', { class: 'side-slot', 'data-tab': id }, panel));
    this.root.append(this.tabs, this.body);
    this.render();
  }

  /** The tab in front, or null while the panel is hidden. */
  get visibleTab(): SideTab | null {
    return this.hiddenNow ? null : this.tab;
  }

  get hidden(): boolean {
    return this.hiddenNow;
  }

  /** Bring `tab` to the front, showing the panel if it is hidden. */
  show(tab: SideTab): void {
    const changed = tab !== this.tab || this.hiddenNow;
    this.tab = tab;
    this.hiddenNow = false;
    this.commit(changed);
  }

  setHidden(hidden: boolean): void {
    const changed = hidden !== this.hiddenNow;
    this.hiddenNow = hidden;
    this.commit(changed);
  }

  toggle(): void {
    this.setHidden(!this.hiddenNow);
  }

  /** Open threads, and threads with messages this name has not seen. */
  setCommentCount(open: number, unread: number): void {
    if (open === this.commentCount && unread === this.commentUnread) return;
    this.commentCount = open;
    this.commentUnread = unread;
    this.renderTabs();
  }

  setChatUnread(unread: number, mentioned: boolean): void {
    if (unread === this.chatUnread && mentioned === this.chatMentioned) return;
    this.chatUnread = unread;
    this.chatMentioned = mentioned;
    this.renderTabs();
  }

  private commit(changed: boolean): void {
    try { localStorage.setItem(KEY, JSON.stringify({ tab: this.tab, hidden: this.hiddenNow })); } catch { /* this page only */ }
    this.render();
    if (changed) this.opts.onChange(this.visibleTab);
  }

  private render(): void {
    this.root.classList.toggle('collapsed', this.hiddenNow);
    for (const slot of this.body.children) (slot as HTMLElement).classList.toggle('active', (slot as HTMLElement).dataset.tab === this.tab);
    this.renderTabs();
  }

  private renderTabs(): void {
    const tab = (id: SideTab, ...content: Array<Node | string | null>) => {
      const b = h('button', { class: `tab${this.tab === id ? ' active' : ''}` }, ...content);
      b.addEventListener('click', () => this.show(id));
      return b;
    };
    this.tabs.replaceChildren(
      tab('files', 'Files'),
      tab('comments', 'Comments',
        this.commentCount ? h('span', { class: 'count', title: 'Open threads' }, String(this.commentCount)) : null,
        this.commentUnread ? h('span', { class: 'count unread', title: 'Threads with new messages' }, String(this.commentUnread)) : null),
      tab('chat', 'Chat', this.chatUnread ? h('span', { class: `count${this.chatMentioned ? ' mention' : ''}`, title: this.chatMentioned ? 'Unread, and you were mentioned' : 'Unread messages' }, String(this.chatUnread)) : null),
    );
  }
}
