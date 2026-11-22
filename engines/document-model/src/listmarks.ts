/**
 * Per-level list markers shared by renderers (UI, PDF, Markdown).
 * Levels: 0 "1."  1 "a."  2 "i."  3 "1)" — bullets: level glyph table.
 */

export function intToAlpha(n: number): string {
  let s = "";
  let v = n;
  while (v > 0) {
    v -= 1;
    s = String.fromCharCode(97 + (v % 26)) + s;
    v = Math.floor(v / 26);
  }
  return s;
}

const ROMAN: [number, string][] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

export function intToRoman(n: number): string {
  let s = "";
  let v = n;
  for (const [value, sym] of ROMAN) {
    while (v >= value) {
      s += sym;
      v -= value;
    }
  }
  return s;
}

export function numberedMarker(level: number, n: number): string {
  switch (level) {
    case 1: return `${intToAlpha(n)}.`;
    case 2: return `${intToRoman(n)}.`;
    case 3: return `${n})`;
    default: return `${n}.`;
  }
}

/** Track numbered counters across a walk of the document's blocks. */
export class ListCounter {
  private counts = [0, 0, 0, 0];
  /** Raw count behind the last marker (for renderers that need digits). */
  lastCount = 0;
  /** Call per block; returns the marker for numbered blocks, null otherwise. */
  next(type: string, indent: number): string | null {
    if (type !== "numbered") {
      if (type !== "bullet") this.counts = [0, 0, 0, 0]; // non-list resets all
      return null;
    }
    const level = Math.max(0, Math.min(3, indent));
    this.counts[level]!++;
    for (let d = level + 1; d < 4; d++) this.counts[d] = 0;
    this.lastCount = this.counts[level]!;
    return numberedMarker(level, this.counts[level]!);
  }
}

export const BULLET_GLYPHS = ["\u2022", "\u25e6", "\u25aa", "\u2023"]; // • ◦ ▪ ‣
/** WinAnsi-safe bullet bytes for the PDF engine (base-14, no subsetting). */
export const BULLET_WINANSI = ["\x95", "-", "\xb7", "\xbb"]; // • - · »
