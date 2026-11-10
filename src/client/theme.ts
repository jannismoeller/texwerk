import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/**
 * The colour scheme: light (the default) or dark, chosen per browser. The
 * page's colours are CSS variables in style.css, one set per scheme, picked
 * by `data-theme` on <html>. CodeMirror needs its own light or dark theme
 * and a highlight style to match, which every editor gets from
 * `editorTheme()` inside a Compartment and swaps on `onThemeChange`.
 */

export type Theme = 'light' | 'dark';

const KEY = 'texwerk-theme';
const listeners = new Set<(theme: Theme) => void>();

let active: Theme | null = null;

export function currentTheme(): Theme {
  if (!active) {
    try { active = localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch { active = 'light'; }
  }
  return active;
}

/** Put the stored scheme on <html>, before anything is drawn. */
export function applyTheme(theme: Theme = currentTheme()): void {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme): void {
  active = theme;
  try { localStorage.setItem(KEY, theme); } catch { /* this page only */ }
  applyTheme(theme);
  for (const fn of listeners) fn(theme);
}

/** Call `fn` whenever the scheme changes. Returns the unsubscribe function. */
export function onThemeChange(fn: (theme: Theme) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Syntax colours. LaTeX (the stex mode) marks commands as tagName, math
// delimiters as keyword, environment names, labels and citation keys as
// atom, and braces as bracket.

const tokyo = HighlightStyle.define([
  { tag: [t.keyword, t.tagName], color: '#7aa2f7' },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: '#ff9e64' },
  { tag: [t.number], color: '#ff9e64' },
  { tag: [t.string, t.special(t.string)], color: '#9ece6a' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#565f89', fontStyle: 'italic' },
  { tag: [t.bracket, t.brace, t.squareBracket, t.paren], color: '#bb9af7' },
  { tag: [t.variableName, t.typeName], color: '#7dcfff' },
  { tag: [t.definition(t.variableName), t.function(t.variableName)], color: '#7dcfff' },
  { tag: [t.heading], color: '#e0af68', fontWeight: 'bold' },
  { tag: [t.meta, t.processingInstruction], color: '#e0af68' },
  { tag: [t.operator], color: '#89ddff' },
  { tag: [t.invalid], color: '#f7768e' },
]);

// On paper: muted inks, each at least 4.5:1 against the background, except
// comments, which recede on purpose.
const paper = HighlightStyle.define([
  { tag: [t.tagName], color: '#2f6472' },
  { tag: [t.keyword], color: '#8a5a14' },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: '#9c4a2c' },
  { tag: [t.number], color: '#9c4a2c' },
  { tag: [t.string, t.special(t.string)], color: '#4b7330' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#8a867e', fontStyle: 'italic' },
  { tag: [t.bracket, t.brace, t.squareBracket, t.paren], color: '#77588f' },
  { tag: [t.variableName, t.typeName], color: '#2f6472' },
  { tag: [t.definition(t.variableName), t.function(t.variableName)], color: '#2f6472' },
  { tag: [t.heading], color: '#7a5210', fontWeight: 'bold' },
  { tag: [t.meta, t.processingInstruction], color: '#8a5a14' },
  { tag: [t.operator], color: '#5d5a55' },
  { tag: [t.invalid], color: '#b0403c' },
]);

/** CodeMirror's half of the scheme: its light or dark base theme and syntax colours. */
export function editorTheme(theme: Theme = currentTheme()): Extension {
  const dark = theme === 'dark';
  return [EditorView.theme({}, { dark }), syntaxHighlighting(dark ? tokyo : paper)];
}
