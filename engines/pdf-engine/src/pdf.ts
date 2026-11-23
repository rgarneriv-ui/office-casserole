/**
 * Minimal PDF 1.4 generator (spec §9, Write publishing path §6.1).
 * v2 (ADR-0006 update): proportional Helvetica output by default, using
 * verified base-14 AFM widths extracted from a reference implementation
 * (helvetica-metrics.ts, generated — never hand-typed). Line breaking and
 * pagination are computed from those exact metrics, so the §6.4
 * deterministic-pagination requirement still holds truthfully: identical
 * input produces identical bytes. Courier remains available as an option.
 * - WinAnsi text only; characters outside Latin-1 are replaced with '?' and
 *   reported in the loss report rather than silently mangled.
 * - Uncompressed content streams (verifiable by eye and by tests).
 */

import { DocModel, Mark } from "../../document-model/src/types";
import { LossReport, LossWarning } from "../../document-model/src/serialize";
import { FIRST_CHAR, FONT_WIDTHS } from "./helvetica-metrics";
import { BULLET_WINANSI, ListCounter } from "../../document-model/src/listmarks";

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 72;
const BODY_SIZE = 11;
const H1_SIZE = 20;
const H2_SIZE = 15;
const LINE_FACTOR = 1.45;
const COURIER_ADVANCE = 0.6; // em — exact for every Courier glyph

export type PdfFontFamily = "helvetica" | "courier";

type FontKey = "R" | "B" | "I" | "BI";

const FONT_NAMES: Record<PdfFontFamily, Record<FontKey, string>> = {
  helvetica: {
    R: "Helvetica",
    B: "Helvetica-Bold",
    I: "Helvetica-Oblique",
    BI: "Helvetica-BoldOblique",
  },
  courier: {
    R: "Courier",
    B: "Courier-Bold",
    I: "Courier-Oblique",
    BI: "Courier-BoldOblique",
  },
};

const HELVETICA_TABLES: Record<FontKey, number[]> = {
  R: FONT_WIDTHS.helvetica!,
  B: FONT_WIDTHS.helveticaBold!,
  I: FONT_WIDTHS.helveticaOblique!,
  BI: FONT_WIDTHS.helveticaBoldOblique!,
};

/** Width of `text` in points, from exact per-family metrics. */
export function measureText(
  text: string,
  font: FontKey,
  size: number,
  family: PdfFontFamily
): number {
  if (family === "courier") return text.length * size * COURIER_ADVANCE;
  const table = HELVETICA_TABLES[font];
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const w = table[code - FIRST_CHAR];
    units += w && w > 0 ? w : 500; // sanitize() keeps codes in-table; 500 is a safe fallback
  }
  return (units / 1000) * size;
}

interface Span {
  text: string;
  font: FontKey;
  underline: boolean;
  strike?: boolean;
}

interface Line {
  spans: Span[];
  size: number;
}

function fontFor(marks: Mark[], forceBold: boolean): FontKey {
  const b = forceBold || marks.includes("bold");
  const i = marks.includes("italic");
  return b && i ? "BI" : b ? "B" : i ? "I" : "R";
}

function sanitize(text: string, warnings: LossWarning[], blockIndex: number): string {
  let replaced = false;
  const out = [...text]
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      if (code === 0x0a || code === 0x0d) return " ";
      if (code >= 32 && code <= 126) return ch;
      if (code >= 0xa0 && code <= 0xff) return ch; // WinAnsi upper range
      replaced = true;
      return "?";
    })
    .join("");
  if (replaced) {
    warnings.push({
      code: "PDF-CHARSET",
      message: "Characters outside Latin-1 were replaced with '?' (font subsetting not yet implemented).",
      blockIndex,
    });
  }
  return out;
}

/** Deterministic greedy word wrap using exact font metrics. */
function wrapBlock(
  spans: Span[],
  size: number,
  maxWidth: number,
  family: PdfFontFamily
): Line[] {
  const lines: Line[] = [];
  let current: Span[] = [];
  let used = 0;

  const coalesce = (list: Span[]): Span[] => {
    const out: Span[] = [];
    for (const s of list) {
      const prev = out[out.length - 1];
      if (prev && prev.font === s.font && prev.underline === s.underline && !!prev.strike === !!s.strike) prev.text += s.text;
      else out.push({ ...s });
    }
    const last = out[out.length - 1];
    if (last) last.text = last.text.replace(/\s+$/, "");
    return out.filter((s) => s.text.length > 0);
  };

  const pushLine = () => {
    lines.push({ spans: coalesce(current), size });
    current = [];
    used = 0;
  };

  for (const span of spans) {
    for (const token of span.text.split(/(\s+)/)) {
      if (token === "") continue;
      const isSpace = /^\s+$/.test(token);
      const tokenW = measureText(token, span.font, size, family);
      if (used + tokenW <= maxWidth) {
        current.push({ ...span, text: token });
        used += tokenW;
        continue;
      }
      if (isSpace) {
        pushLine(); // spaces never start a new line
        continue;
      }
      if (tokenW <= maxWidth) {
        pushLine();
        current.push({ ...span, text: token });
        used = tokenW;
      } else {
        // hard-break an over-long word by characters
        let rest = token;
        while (rest.length > 0) {
          let take = 0;
          let w = 0;
          while (take < rest.length) {
            const cw = measureText(rest[take]!, span.font, size, family);
            if (used + w + cw > maxWidth && (take > 0 || current.length > 0 || used > 0)) break;
            w += cw;
            take++;
          }
          if (take === 0) {
            pushLine();
            continue;
          }
          current.push({ ...span, text: rest.slice(0, take) });
          used += w;
          rest = rest.slice(take);
          if (rest.length > 0) pushLine();
        }
      }
    }
  }
  if (current.length > 0 || lines.length === 0) pushLine();
  return lines;
}

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Latin-1 byte encoding for string output. */
function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export interface PdfOptions {
  font?: PdfFontFamily;
}

export function exportPdf(
  model: DocModel,
  options: PdfOptions = {}
): { bytes: Uint8Array; report: LossReport } {
  const family: PdfFontFamily = options.font ?? "helvetica";
  const warnings: LossWarning[] = [];
  const maxWidth = PAGE_W - 2 * MARGIN;

  // layout: blocks → lines → pages
  interface PlacedText {
    kind: "text";
    line: Line;
    y: number;
    x: number;
    prefix?: string | null;
  }
  interface PlacedRule {
    kind: "rule";
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }
  type Placed = PlacedText | PlacedRule;
  const pages: Placed[][] = [];
  let page: Placed[] = [];
  let y = PAGE_H - MARGIN;

  const LIST_INDENT = 22; // points per level
  const listCounter = new ListCounter();
  model.blocks.forEach((block, bi) => {
    if (block.type === "table" && block.table) {
      const pad = 4;
      const cols = block.table[0]!.length;
      const tStyle = block.tableStyle ?? {};
      const weights = tStyle.widths ?? new Array<number>(cols).fill(1);
      const weightSum = weights.reduce((a, b) => a + b, 0);
      const colWs = weights.map((w) => (maxWidth * w) / weightSum);
      const colX = [MARGIN];
      for (const w of colWs) colX.push(colX[colX.length - 1]! + w);
      const lineH = BODY_SIZE * LINE_FACTOR;
      y -= 4; // breathing room above the grid

      block.table.forEach((row, rIdx) => {
        const isHeader = tStyle.headerRow === true && rIdx === 0;
        const cellFont: FontKey = isHeader ? "B" : "R";
        // wrap every cell (preserving explicit newlines)
        const cellLines: Line[][] = row.map((cell, cIdx) => {
          const out: Line[] = [];
          const cellMeasure = colWs[cIdx]! - 2 * pad;
          for (const segment of sanitize(cell, warnings, bi).split("\n")) {
            out.push(
              ...wrapBlock([{ text: segment, font: cellFont, underline: false }], BODY_SIZE, cellMeasure, family)
            );
          }
          return out;
        });
        const rowLines = Math.max(1, ...cellLines.map((c) => c.length));
        const rowH = rowLines * lineH + 2 * pad;

        if (y - rowH < MARGIN && page.length > 0) {
          page.push({ kind: "rule", x1: MARGIN, y1: y, x2: MARGIN + maxWidth, y2: y });
          pages.push(page);
          page = [];
          y = PAGE_H - MARGIN;
        }
        const top = y;
        const bottom = y - rowH;
        // row borders: top + verticals (bottom comes from the next row's top, or the closer)
        page.push({ kind: "rule", x1: MARGIN, y1: top, x2: MARGIN + maxWidth, y2: top });
        for (let c = 0; c <= cols; c++) {
          page.push({ kind: "rule", x1: colX[c]!, y1: top, x2: colX[c]!, y2: bottom });
        }
        cellLines.forEach((linesInCell, c) => {
          const align = tStyle.aligns?.[c] ?? null;
          linesInCell.forEach((line, li) => {
            let x = colX[c]! + pad;
            if (align === "center" || align === "right") {
              const lw = line.spans.reduce(
                (n, sp) => n + measureText(sp.text, sp.font, line.size, family),
                0
              );
              const free = colWs[c]! - 2 * pad - lw;
              x += align === "center" ? free / 2 : free;
            }
            page.push({
              kind: "text",
              line,
              x,
              y: top - pad - BODY_SIZE - li * lineH,
            });
          });
        });
        y = bottom;
      });
      page.push({ kind: "rule", x1: MARGIN, y1: y, x2: MARGIN + maxWidth, y2: y });
      y -= BODY_SIZE;
      return;
    }
    if (block.pageBreakBefore && page.length > 0) {
      pages.push(page);
      page = [];
      y = PAGE_H - MARGIN;
    }
    if (block.runs.some((r) => r.size || r.color || r.highlight || r.font || r.link)) {
      warnings.push({
        code: "PDF-RUNPROPS",
        message: "Per-run font size/color/highlight/family/links render at block defaults in PDF (not yet supported).",
        blockIndex: bi,
      });
    }
    const isList = block.type === "bullet" || block.type === "numbered";
    const level = isList ? Math.min(3, block.indent ?? 0) : 0;
    const marker = listCounter.next(block.type, level);
    const size =
      block.type === "heading1" ? H1_SIZE : block.type === "heading2" ? H2_SIZE : BODY_SIZE;
    const forceBold = block.type === "heading1" || block.type === "heading2";
    const spans: Span[] =
      block.runs.length > 0
        ? block.runs.map((r) => ({
            text: sanitize(r.text, warnings, bi),
            font: fontFor(r.marks, forceBold),
            underline: r.marks.includes("underline"),
            strike: r.marks.includes("strike"),
          }))
        : [{ text: "", font: forceBold ? "B" : "R", underline: false }];
    const indent = isList ? LIST_INDENT * (level + 1) : 0;
    const lines = wrapBlock(spans, size, maxWidth - indent, family);
    const lineH = size * LINE_FACTOR * (block.spacing && block.spacing > 0 ? block.spacing : 1);
    const spaceBefore = isList || block.type === "paragraph" ? 0 : size * 0.6;
    // WinAnsi-safe per-level glyphs (base-14 fonts, no subsetting)
    const prefix =
      block.type === "bullet" ? BULLET_WINANSI[level]! : block.type === "numbered" ? marker : null;

    y -= spaceBefore;
    lines.forEach((line, li) => {
      if (y - lineH < MARGIN) {
        pages.push(page);
        page = [];
        y = PAGE_H - MARGIN;
      }
      y -= lineH;
      let x = MARGIN + indent;
      if (block.align === "center" || block.align === "right") {
        const lineW = line.spans.reduce((wsum, sp) => wsum + measureText(sp.text, sp.font, line.size, family), 0);
        const free = Math.max(0, maxWidth - indent - lineW);
        x += block.align === "center" ? free / 2 : free;
      }
      page.push({ kind: "text", line, y, x, prefix: li === 0 ? prefix : null });
    });
    y -= BODY_SIZE * 0.5; // paragraph spacing
  });
  pages.push(page);

  // content streams
  const contentStreams = pages.map((placed) => {
    const ops: string[] = [];
    for (const item of placed) {
      if (item.kind === "rule") {
        ops.push(
          `${item.x1.toFixed(2)} ${item.y1.toFixed(2)} m ${item.x2.toFixed(2)} ${item.y2.toFixed(2)} l 0.5 w S`
        );
        continue;
      }
      const { line, y: ly, prefix } = item;
      if (prefix) {
        const px = Math.max(MARGIN, item.x - 18);
        ops.push(
          `BT /FR ${line.size} Tf ${px.toFixed(2)} ${ly.toFixed(2)} Td (${pdfEscape(prefix)}) Tj ET`
        );
      }
      let x = item.x;
      for (const span of line.spans) {
        if (span.text.length === 0) continue;
        const w = measureText(span.text, span.font, line.size, family);
        ops.push(
          `BT /F${span.font} ${line.size} Tf ${x.toFixed(2)} ${ly.toFixed(2)} Td (${pdfEscape(span.text)}) Tj ET`
        );
        if (span.underline) {
          const uy = ly - 1.5;
          ops.push(
            `${x.toFixed(2)} ${uy.toFixed(2)} m ${(x + w).toFixed(2)} ${uy.toFixed(2)} l 0.5 w S`
          );
        }
        if (span.strike) {
          // mid x-height strike, like Word's single strikethrough
          const sy = ly + line.size * 0.27;
          ops.push(
            `${x.toFixed(2)} ${sy.toFixed(2)} m ${(x + w).toFixed(2)} ${sy.toFixed(2)} l 0.5 w S`
          );
        }
        x += w;
      }
    }
    return ops.join("\n");
  });

  // assemble objects
  const objects: Uint8Array[] = []; // index = object number - 1
  const push = (body: string): number => {
    objects.push(latin1Bytes(body));
    return objects.length;
  };

  const fontKeys: FontKey[] = ["R", "B", "I", "BI"];
  const fontObjNums: Record<string, number> = {};
  for (const k of fontKeys) {
    fontObjNums[k] = push(
      `<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAMES[family][k]} /Encoding /WinAnsiEncoding >>`
    );
  }
  const fontDict = fontKeys.map((k) => `/F${k} ${fontObjNums[k]} 0 R`).join(" ");

  const contentNums = contentStreams.map((s) =>
    push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`)
  );

  // reserve numbers: pages tree after content, then page objects, then catalog
  const pagesNum = objects.length + 1 + contentNums.length; // after page objects
  const pageNums = contentNums.map((cNum) =>
    push(
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << ${fontDict} >> >> /Contents ${cNum} 0 R >>`
    )
  );
  const pagesActual = push(
    `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNums.length} >>`
  );
  if (pagesActual !== pagesNum) throw new Error("PDF writer: pages object number mismatch");
  const catalogNum = push(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);

  // serialize with xref
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const add = (bytes: Uint8Array) => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  add(latin1Bytes("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"));
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    add(latin1Bytes(`${i + 1} 0 obj\n`));
    add(body);
    add(latin1Bytes(`\nendobj\n`));
  });
  const xrefStart = offset;
  const xref =
    `xref\n0 ${objects.length + 1}\n` +
    `0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  add(latin1Bytes(xref));
  add(
    latin1Bytes(
      `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
    )
  );

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    bytes.set(c, pos);
    pos += c.length;
  }

  if (family === "courier") {
    warnings.push({
      code: "PDF-FONT-FAMILY",
      message: "Rendered in Courier (fixed-pitch) as requested.",
      blockIndex: -1,
    });
  }
  return { bytes, report: { format: "pdf", lossless: warnings.length === 0, warnings } };
}
