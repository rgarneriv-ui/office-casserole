/**
 * Clipboard semantics for the spreadsheet (spec §7.1 grid requirements):
 * copying a formula and pasting it elsewhere shifts its relative references
 * by the paste offset, exactly like Excel; `$` anchors pin a column and/or
 * row. Out-of-range results (shifted above row 1 / left of column A) become
 * #REF! — written literally into the formula, never silently clamped.
 */

import { colToName, formatAddr, nameToCol, parseAddr } from "./addr";
import { CellFormat, Sheet } from "./engine";
import { tokenize } from "./parse";

const REF_RE = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)$/;

/** Rewrite the relative references of a formula body (no leading '=') by a
 *  row/column offset. Function names (ident followed by "(") are untouched. */
export function shiftFormula(body: string, dRow: number, dCol: number): string {
  let tokens;
  try {
    tokens = tokenize(body);
  } catch {
    return body; // unparsable input is left alone (it evaluates to #PARSE! anyway)
  }
  // splice replacements for reference idents only; every other character of
  // the original body (strings, spacing, operators) is preserved verbatim
  const edits: { start: number; end: number; repl: string }[] = [];
  tokens.forEach((tok, i) => {
    if (tok.kind !== "ident") return;
    const isCall = tokens[i + 1]?.kind === "op" && tokens[i + 1]?.text === "(";
    if (isCall) return;
    const m = REF_RE.exec(tok.text);
    if (!m || !parseAddr(tok.text)) return;
    const colAnchored = m[1] === "$";
    const rowAnchored = m[3] === "$";
    let col = nameToCol(m[2]!);
    let row = parseInt(m[4]!, 10) - 1;
    if (!colAnchored) col += dCol;
    if (!rowAnchored) row += dRow;
    const repl =
      col < 0 || row < 0
        ? "#REF!"
        : `${colAnchored ? "$" : ""}${colToName(col)}${rowAnchored ? "$" : ""}${row + 1}`;
    edits.push({ start: tok.pos, end: tok.pos + tok.text.length, repl });
  });
  let out = "";
  let cursor = 0;
  for (const e of edits) {
    out += body.slice(cursor, e.start) + e.repl;
    cursor = e.end;
  }
  return out + body.slice(cursor);
}

export interface ClipCell {
  /** offset within the copied rectangle */
  dRow: number;
  dCol: number;
  input: string;
  format?: CellFormat;
}

export interface ClipData {
  rows: number;
  cols: number;
  /** sheet position the rectangle was copied from (for formula rebasing) */
  srcRow: number;
  srcCol: number;
  cells: ClipCell[];
}

export interface Rect {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export function normalizeRect(aAddr: string, bAddr: string): Rect {
  const a = parseAddr(aAddr)!;
  const b = parseAddr(bAddr)!;
  return {
    r0: Math.min(a.row, b.row),
    c0: Math.min(a.col, b.col),
    r1: Math.max(a.row, b.row),
    c1: Math.max(a.col, b.col),
  };
}

export function copyRange(sheet: Sheet, rect: Rect): ClipData {
  const cells: ClipCell[] = [];
  for (let r = rect.r0; r <= rect.r1; r++) {
    for (let c = rect.c0; c <= rect.c1; c++) {
      const addr = formatAddr({ col: c, row: r });
      const input = sheet.getInput(addr);
      const format = sheet.getFormat(addr);
      if (input !== "" || Object.keys(format).length > 0) {
        const cell: ClipCell = { dRow: r - rect.r0, dCol: c - rect.c0, input };
        if (Object.keys(format).length > 0) cell.format = format;
        cells.push(cell);
      }
    }
  }
  return {
    rows: rect.r1 - rect.r0 + 1,
    cols: rect.c1 - rect.c0 + 1,
    srcRow: rect.r0,
    srcCol: rect.c0,
    cells,
  };
}

export function clearRange(sheet: Sheet, rect: Rect): void {
  for (let r = rect.r0; r <= rect.r1; r++) {
    for (let c = rect.c0; c <= rect.c1; c++) {
      const addr = formatAddr({ col: c, row: r });
      if (sheet.getInput(addr) !== "") sheet.setCell(addr, "");
    }
  }
}

/** Paste a copied rectangle at a target anchor, shifting relative formula
 *  references by the move. Returns the pasted rect. */
export function pasteClip(sheet: Sheet, clip: ClipData, atAddr: string): Rect {
  const at = parseAddr(atAddr)!;
  const dRow = at.row - clip.srcRow;
  const dCol = at.col - clip.srcCol;
  const rect: Rect = {
    r0: at.row,
    c0: at.col,
    r1: at.row + clip.rows - 1,
    c1: at.col + clip.cols - 1,
  };
  clearRange(sheet, rect); // the full destination footprint, then write
  for (const cell of clip.cells) {
    const addr = formatAddr({ col: at.col + cell.dCol, row: at.row + cell.dRow });
    let input = cell.input;
    if (input.startsWith("=")) {
      input = "=" + shiftFormula(input.slice(1), dRow, dCol);
    }
    if (input !== "") sheet.setCell(addr, input);
    if (cell.format) sheet.setFormat(addr, cell.format);
  }
  return rect;
}

/** Values-only TSV of a rect (what goes to the system clipboard). */
export function rangeToTSV(sheet: Sheet, rect: Rect): string {
  const lines: string[] = [];
  for (let r = rect.r0; r <= rect.r1; r++) {
    const row: string[] = [];
    for (let c = rect.c0; c <= rect.c1; c++) {
      row.push(sheet.getDisplay(formatAddr({ col: c, row: r })).replace(/[\t\n]/g, " "));
    }
    lines.push(row.join("\t"));
  }
  return lines.join("\n");
}

/** Paste external TSV text as literal values at an anchor. */
export function pasteTSV(sheet: Sheet, tsv: string, atAddr: string): Rect {
  const at = parseAddr(atAddr)!;
  const rows = tsv.replace(/\r/g, "").replace(/\n$/, "").split("\n");
  let maxCols = 1;
  rows.forEach((line, r) => {
    const cells = line.split("\t");
    maxCols = Math.max(maxCols, cells.length);
    cells.forEach((value, c) => {
      sheet.setCell(formatAddr({ col: at.col + c, row: at.row + r }), value);
    });
  });
  return { r0: at.row, c0: at.col, r1: at.row + rows.length - 1, c1: at.col + maxCols - 1 };
}
