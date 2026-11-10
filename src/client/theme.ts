import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/**
 * The colour theme, chosen per browser. The page's colours are CSS variables
 * in style.css, one block per theme, picked by `data-theme` on <html>.
 * CodeMirror needs its own light or dark base theme and a highlight style to
 * match, which every editor gets from `editorTheme()` inside a Compartment
 * and swaps on `onThemeChange`.
 *
 * Adding a theme: a `:root[data-theme="<id>"]` variable block in style.css,
 * a HighlightStyle below, and an entry in THEMES.
 */

export interface ThemeInfo {
  id: string;
  label: string;
  /** Dark themes get CodeMirror's dark base and the moon icon. */
  dark: boolean;
  highlight: HighlightStyle;
  /** Background, text and accent, for the swatch in the theme menu. */
  swatch: [string, string, string];
}

export type Theme = string;

const KEY = 'texwerk-theme';
const listeners = new Set<(theme: Theme) => void>();

let active: Theme | null = null;

export function currentTheme(): Theme {
  if (!active) {
    let stored: string | null = null;
    try { stored = localStorage.getItem(KEY); } catch { /* default */ }
    active = THEMES.some((t) => t.id === stored) ? stored! : THEMES[0].id;
  }
  return active;
}

export function themeInfo(theme: Theme = currentTheme()): ThemeInfo {
  return THEMES.find((t) => t.id === theme) ?? THEMES[0];
}

/** Put the stored theme on <html>, before anything is drawn. */
export function applyTheme(theme: Theme = currentTheme()): void {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme): void {
  active = themeInfo(theme).id;
  try { localStorage.setItem(KEY, active); } catch { /* this page only */ }
  applyTheme(active);
  for (const fn of listeners) fn(active);
}

/** Call `fn` whenever the theme changes. Returns the unsubscribe function. */
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

// Warm dark greys: low-saturation inks of similar brightness, so no colour
// glares, with comments receding.
const ember = HighlightStyle.define([
  { tag: [t.tagName], color: '#8fb0bf' },
  { tag: [t.keyword], color: '#d1a96f' },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: '#c8957c' },
  { tag: [t.number], color: '#c8957c' },
  { tag: [t.string, t.special(t.string)], color: '#a5b886' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#827c72', fontStyle: 'italic' },
  { tag: [t.bracket, t.brace, t.squareBracket, t.paren], color: '#b29fbf' },
  { tag: [t.variableName, t.typeName], color: '#93b5ac' },
  { tag: [t.definition(t.variableName), t.function(t.variableName)], color: '#93b5ac' },
  { tag: [t.heading], color: '#d8b97c', fontWeight: 'bold' },
  { tag: [t.meta, t.processingInstruction], color: '#d1a96f' },
  { tag: [t.operator], color: '#a9a398' },
  { tag: [t.invalid], color: '#d6806f' },
]);

/** The themes in menu order; the first is the default. */
export const THEMES: ThemeInfo[] = [
  { id: 'light', label: 'Light', dark: false, highlight: paper, swatch: ['#fbfaf8', '#2b2a28', '#3e6b77'] },
  { id: 'dark', label: 'Dark', dark: true, highlight: ember, swatch: ['#201f1d', '#d4cfc6', '#86a9b0'] },
  { id: 'tokyo-night', label: 'Tokyo Night', dark: true, highlight: tokyo, swatch: ['#1a1b26', '#c0caf5', '#7aa2f7'] },
];

/** CodeMirror's half of the theme: its light or dark base theme and syntax colours. */
export function editorTheme(theme: Theme = currentTheme()): Extension {
  const info = themeInfo(theme);
  return [EditorView.theme({}, { dark: info.dark }), syntaxHighlighting(info.highlight)];
}
