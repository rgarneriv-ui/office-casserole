/**
 * Minimal PDF 1.4 generator (spec §9, Write publishing path §6.1).
 * Deliberate v0 constraints, recorded in ADR-0006:
 * - Courier family only: every glyph advances exactly 600/1000 em, so line
 *   breaking and pagination are exact, not approximated — the §6.4
 *   deterministic-pagination requirement holds truthfully for this font.
 * - WinAnsi text only; characters outside Latin-1 are replaced with '?' and
 *   reported in the loss report rather than silently mangled.
 * - Uncompressed content streams (verifiable by eye and by tests).
 */

import { DocModel, Mark } from "../../document-model/src/types";
import { LossReport, LossWarning } from "../../document-model/src/serialize";

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 72;
const BODY_SIZE = 11;
const H1_SIZE = 20;
const H2_SIZE = 15;
const LINE_FACTOR = 1.45;
const COURIER_ADVANCE = 0.6; // em — exact for every Courier glyph

type FontKey = "R" | "B" | "I" | "BI";

const FONT_NAMES: Record<FontKey, string> = {
  R: "Courier",
  B: "Courier-Bold",
  I: "Courier-Oblique",
  BI: "Courier-BoldOblique",
};

interface Span {
  text: string;
  font: FontKey;
  underline: boolean;
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

/** Deterministic greedy word wrap using exact Courier advances. */
function wrapBlock(
  spans: Span[],
  size: number,
  maxWidth: number
): Line[] {
  const charW = size * COURIER_ADVANCE;
  const maxChars = Math.max(1, Math.floor(maxWidth / charW));
  const lines: Line[] = [];
  let current: Span[] = [];
  let count = 0;

  const coalesce = (spans: Span[]): Span[] => {
    const out: Span[] = [];
    for (const s of spans) {
      const prev = out[out.length - 1];
      if (prev && prev.font === s.font && prev.underline === s.underline) prev.text += s.text;
      else out.push({ ...s });
    }
    // trailing whitespace never renders or underlines
    const last = out[out.length - 1];
    if (last) last.text = last.text.replace(/\s+$/, "");
    return out.filter((s) => s.text.length > 0);
  };

  const pushLine = () => {
    lines.push({ spans: coalesce(current), size });
    current = [];
    count = 0;
  };

  for (const span of spans) {
    // split into word/space tokens, preserving the span's styling
    for (const token of span.text.split(/(\s+)/)) {
      if (token === "") continue;
      const isSpace = /^\s+$/.test(token);
      if (count + token.length <= maxChars) {
        current.push({ ...span, text: token });
        count += token.length;
        continue;
      }
      if (isSpace) {
        pushLine(); // spaces never start a new line
        continue;
      }
      if (token.length <= maxChars) {
        pushLine();
        current.push({ ...span, text: token });
        count = token.length;
      } else {
        // hard-break an over-long word
        let rest = token;
        while (rest.length > 0) {
          const room = maxChars - count;
          if (room <= 0) {
            pushLine();
            continue;
          }
          current.push({ ...span, text: rest.slice(0, room) });
          count += Math.min(room, rest.length);
          rest = rest.slice(room);
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

export function exportPdf(model: DocModel): { bytes: Uint8Array; report: LossReport } {
  const warnings: LossWarning[] = [];
  const maxWidth = PAGE_W - 2 * MARGIN;

  // layout: blocks → lines → pages
  interface Placed {
    line: Line;
    y: number;
  }
  const pages: Placed[][] = [];
  let page: Placed[] = [];
  let y = PAGE_H - MARGIN;

  model.blocks.forEach((block, bi) => {
    const size =
      block.type === "heading1" ? H1_SIZE : block.type === "heading2" ? H2_SIZE : BODY_SIZE;
    const forceBold = block.type !== "paragraph";
    const spans: Span[] =
      block.runs.length > 0
        ? block.runs.map((r) => ({
            text: sanitize(r.text, warnings, bi),
            font: fontFor(r.marks, forceBold),
            underline: r.marks.includes("underline"),
          }))
        : [{ text: "", font: forceBold ? "B" : "R", underline: false }];
    const lines = wrapBlock(spans, size, maxWidth);
    const lineH = size * LINE_FACTOR;
    const spaceBefore = block.type === "paragraph" ? 0 : size * 0.6;

    y -= spaceBefore;
    for (const line of lines) {
      if (y - lineH < MARGIN) {
        pages.push(page);
        page = [];
        y = PAGE_H - MARGIN;
      }
      y -= lineH;
      page.push({ line, y });
    }
    y -= BODY_SIZE * 0.5; // paragraph spacing
  });
  pages.push(page);

  // content streams
  const contentStreams = pages.map((placed) => {
    const ops: string[] = [];
    for (const { line, y: ly } of placed) {
      let x = MARGIN;
      for (const span of line.spans) {
        if (span.text.length === 0) continue;
        const w = span.text.length * line.size * COURIER_ADVANCE;
        ops.push(
          `BT /F${span.font} ${line.size} Tf ${x.toFixed(2)} ${ly.toFixed(2)} Td (${pdfEscape(span.text)}) Tj ET`
        );
        if (span.underline) {
          const uy = ly - 1.5;
          ops.push(
            `${x.toFixed(2)} ${uy.toFixed(2)} m ${(x + w).toFixed(2)} ${uy.toFixed(2)} l 0.5 w S`
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
      `<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAMES[k]} /Encoding /WinAnsiEncoding >>`
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

  warnings.push({
    code: "PDF-FONT-FAMILY",
    message:
      "Rendered in Courier (fixed-pitch) for exact deterministic layout; proportional fonts with real metrics are a later work order.",
    blockIndex: -1,
  });
  return { bytes, report: { format: "pdf", lossless: false, warnings } };
}
