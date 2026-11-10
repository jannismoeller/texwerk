// The legacy build, as in viewer.ts.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { PdfGlyph } from '@shared/pdfMatch.ts';

/**
 * Every glyph a page draws, with its box: where comments are marked.
 *
 * PDF.js's text content gives one box per run of text, and its text layer
 * spaces the characters inside a run with a browser font, so a character
 * there can sit several points away from the glyph on the canvas (after a
 * list bullet, for example). The page's operator list has each glyph's
 * advance width instead, so this follows the text operators the way PDF.js's
 * canvas does (text matrix, Td, TJ spacing, char and word spacing,
 * horizontal scaling, rise, cm, save and restore, form XObjects) and gets
 * each glyph's exact horizontal extent. Vertically a glyph spans its font's
 * ascent and descent. Vertical writing and Type3 glyph shapes are treated
 * like horizontal text.
 */

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  // m applied first, then n (PDF.js's Util.transform(n, m) order).
  return [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

interface FontInfo {
  matrix: number[];
  ascent: number;
  descent: number;
}

interface TextState {
  ctm: Matrix;
  font: FontInfo;
  fontSize: number;
  fontDirection: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  textMatrix: Matrix | null;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
}

interface Glyph {
  unicode?: string;
  width?: number;
  isSpace?: boolean;
}

const DEFAULT_FONT: FontInfo = { matrix: [0.001, 0, 0, 0.001, 0, 0], ascent: 0.8, descent: -0.2 };

/** A font's metrics, once PDF.js has loaded it (it may never, then defaults). */
function fontInfo(page: PDFPageProxy, name: string): Promise<FontInfo> {
  return new Promise((resolve) => {
    const done = (font: { fontMatrix?: number[]; ascent?: number; descent?: number } | null) => {
      const ascent = Number(font?.ascent);
      const descent = Number(font?.descent);
      resolve({
        matrix: font?.fontMatrix ?? DEFAULT_FONT.matrix,
        // Some fonts report nothing or nonsense: then a usual text font's.
        ascent: ascent > 0.5 && ascent < 1.2 ? ascent : DEFAULT_FONT.ascent,
        descent: descent < 0 && descent > -0.5 ? descent : DEFAULT_FONT.descent,
      });
    };
    const timer = setTimeout(() => done(null), 3000);
    try {
      page.commonObjs.get(name, (font: never) => { clearTimeout(timer); done(font); });
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}

/** The page's glyphs in drawing order, in PDF points from the page's top-left. */
export async function pageGlyphs(page: PDFPageProxy, pageNumber: number): Promise<PdfGlyph[]> {
  const ops = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  const fonts = new Map<string, FontInfo>();
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] === OPS.setFont) {
      const name = String(ops.argsArray[i][0]);
      if (!fonts.has(name)) fonts.set(name, DEFAULT_FONT);
    }
  }
  await Promise.all([...fonts.keys()].map(async (name) => fonts.set(name, await fontInfo(page, name))));

  const viewport = page.getViewport({ scale: 1 });
  const out: PdfGlyph[] = [];
  let s: TextState = {
    ctm: IDENTITY, font: DEFAULT_FONT, fontSize: 0, fontDirection: 1, charSpacing: 0, wordSpacing: 0,
    hScale: 1, leading: 0, rise: 0, textMatrix: null, x: 0, y: 0, lineX: 0, lineY: 0,
  };
  const stack: TextState[] = [];
  const moveText = (x: number, y: number) => { s.x = s.lineX += x; s.y = s.lineY += y; };

  const showText = (glyphs: Array<Glyph | number>) => {
    if (!s.fontSize) return;
    const hScale = s.hScale * s.fontDirection;
    const advanceScale = s.fontSize * s.font.matrix[0];
    // Text space to page space: rise and position, then the text matrix, then the CTM.
    const toPage = multiply(s.textMatrix ?? IDENTITY, s.ctm);
    const yUp = s.y + s.rise;
    let x = 0;
    for (const g of glyphs) {
      if (typeof g === 'number') { x -= g * s.fontSize / 1000; continue; }
      const width = (g.width ?? 0) * advanceScale;
      const spacing = (g.isSpace ? s.wordSpacing : 0) + s.charSpacing;
      const left = s.x + x * hScale;
      const right = s.x + (x + width) * hScale;
      const corners = [
        apply(toPage, left, yUp + s.font.descent * s.fontSize), apply(toPage, right, yUp + s.font.descent * s.fontSize),
        apply(toPage, left, yUp + s.font.ascent * s.fontSize), apply(toPage, right, yUp + s.font.ascent * s.fontSize),
      ].map(([px, py]) => viewport.convertToViewportPoint(px, py) as [number, number]);
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      out.push({ page: pageNumber, text: g.unicode ?? '', x0: Math.min(...xs), x1: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) });
      x += width + spacing * s.fontDirection;
    }
    s.x += x * hScale;
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    switch (fn) {
      case OPS.save: stack.push({ ...s }); break;
      case OPS.restore: if (stack.length) s = stack.pop()!; break;
      case OPS.transform: s.ctm = multiply(args.map(Number) as Matrix, s.ctm); break;
      case OPS.paintFormXObjectBegin:
        stack.push({ ...s });
        if (args[0] && (args[0] as ArrayLike<number>).length === 6) s.ctm = multiply(Array.from(args[0] as ArrayLike<number>) as Matrix, s.ctm);
        break;
      case OPS.paintFormXObjectEnd: if (stack.length) s = stack.pop()!; break;
      case OPS.beginText: s.textMatrix = null; s.x = s.lineX = 0; s.y = s.lineY = 0; break;
      case OPS.setFont: {
        const size = Number(args[1]);
        s.font = fonts.get(String(args[0])) ?? DEFAULT_FONT;
        s.fontDirection = size < 0 ? -1 : 1;
        s.fontSize = Math.abs(size);
        break;
      }
      case OPS.setCharSpacing: s.charSpacing = Number(args[0]); break;
      case OPS.setWordSpacing: s.wordSpacing = Number(args[0]); break;
      case OPS.setHScale: s.hScale = Number(args[0]) / 100; break;
      case OPS.setLeading: s.leading = -Number(args[0]); break;
      case OPS.setTextRise: s.rise = Number(args[0]); break;
      case OPS.moveText: moveText(Number(args[0]), Number(args[1])); break;
      case OPS.setLeadingMoveText: s.leading = Number(args[1]); moveText(Number(args[0]), Number(args[1])); break;
      // One argument, the six numbers as a Float32Array.
      case OPS.setTextMatrix: s.textMatrix = Array.from(args[0] as ArrayLike<number>) as Matrix; s.x = s.lineX = 0; s.y = s.lineY = 0; break;
      case OPS.nextLine: moveText(0, s.leading); break;
      case OPS.showText:
      case OPS.showSpacedText: showText(args[0] as Array<Glyph | number>); break;
      case OPS.nextLineShowText: moveText(0, s.leading); showText(args[0] as Array<Glyph | number>); break;
      case OPS.nextLineSetSpacingShowText:
        s.wordSpacing = Number(args[0]);
        s.charSpacing = Number(args[1]);
        moveText(0, s.leading);
        showText(args[2] as Array<Glyph | number>);
        break;
    }
  }
  return out;
}
