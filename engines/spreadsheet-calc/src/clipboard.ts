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

// ---------- fill handle (WO-33) ----------

function isPlainNumber(input: string): boolean {
  return input !== "" && !input.startsWith("=") && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(input.trim());
}

/**
 * Fill from a source rectangle into an adjacent extension (below or to the
 * right, same cross-axis span). Excel-style semantics per lane (column when
 * filling down, row when filling right):
 * - two or more plain numbers with a consistent step → arithmetic series
 * - otherwise the lane's pattern repeats, with formulas shifted by their
 *   offset from the pattern cell (relative refs move, $ anchors pin)
 * Formats always travel with their pattern cell.
 */
export function fillRange(sheet: Sheet, src: Rect, dest: Rect): void {
  const down = dest.r0 > src.r1;
  const laneCount = down ? src.c1 - src.c0 + 1 : src.r1 - src.r0 + 1;
  const patternLen = down ? src.r1 - src.r0 + 1 : src.c1 - src.c0 + 1;
  const destLen = down ? dest.r1 - dest.r0 + 1 : dest.c1 - dest.c0 + 1;

  for (let lane = 0; lane < laneCount; lane++) {
    const srcAddr = (i: number) =>
      down
        ? formatAddr({ col: src.c0 + lane, row: src.r0 + i })
        : formatAddr({ col: src.c0 + i, row: src.r0 + lane });
    const destAddr = (i: number) =>
      down
        ? formatAddr({ col: dest.c0 + lane, row: dest.r0 + i })
        : formatAddr({ col: dest.c0 + i, row: dest.r0 + lane });

    const inputs = Array.from({ length: patternLen }, (_, i) => sheet.getInput(srcAddr(i)));

    // arithmetic series?
    let series: { start: number; step: number } | null = null;
    if (patternLen >= 2 && inputs.every(isPlainNumber)) {
      const nums = inputs.map(Number);
      const step = nums[1]! - nums[0]!;
      if (nums.every((v, i) => i === 0 || Math.abs(v - nums[i - 1]! - step) < 1e-9)) {
        series = { start: nums[nums.length - 1]!, step };
      }
    }

    for (let i = 0; i < destLen; i++) {
      const target = destAddr(i);
      if (series) {
        const value = series.start + series.step * (i + 1);
        sheet.setCell(target, String(Math.round(value * 1e10) / 1e10));
      } else {
        const pi = i % patternLen;
        let input = inputs[pi]!;
        if (input.startsWith("=")) {
          const from = parseAddr(srcAddr(pi))!;
          const to = parseAddr(target)!;
          input = "=" + shiftFormula(input.slice(1), to.row - from.row, to.col - from.col);
        }
        sheet.setCell(target, input);
      }
      const fmt = sheet.getFormat(srcAddr(series ? patternLen - 1 : i % patternLen));
      if (Object.keys(fmt).length > 0) sheet.setFormat(target, fmt);
    }
  }
}

// ---------- range sort (WO-41) ----------

/**
 * Sort the rows of a rectangle by its first column (Excel's default
 * sort-by-leftmost). Whole rows of the range move together: inputs and
 * formats travel, and formulas are rebased by their row delta so relative
 * references stay pointed at the same relative targets ($ anchors pin),
 * matching fill/paste semantics. Numbers sort before text; empty cells last.
 */
export function sortRange(sheet: Sheet, rect: Rect, descending = false): void {
  const rows: { key: unknown; cells: { input: string; format: CellFormat; srcRow: number }[] }[] = [];
  for (let r = rect.r0; r <= rect.r1; r++) {
    const cells = [];
    for (let c = rect.c0; c <= rect.c1; c++) {
      const addr = formatAddr({ col: c, row: r });
      cells.push({ input: sheet.getInput(addr), format: sheet.getFormat(addr), srcRow: r });
    }
    rows.push({ key: sheet.getCell(formatAddr({ col: rect.c0, row: r })), cells });
  }
  const rank = (k: unknown): number =>
    k === null || k === "" ? 2 : typeof k === "number" ? 0 : 1;
  rows.sort((a, b) => {
    const ra = rank(a.key);
    const rb = rank(b.key);
    if (ra === 2 || rb === 2) return ra - rb; // empties always last, even descending
    if (ra !== rb) return descending ? rb - ra : ra - rb; // Excel: text before numbers when descending
    let cmp: number;
    if (ra === 0) cmp = (a.key as number) - (b.key as number);
    else cmp = String(a.key).localeCompare(String(b.key), undefined, { sensitivity: "base" });
    return descending ? -cmp : cmp;
  });
  rows.forEach((row, i) => {
    const destRow = rect.r0 + i;
    row.cells.forEach((cell, j) => {
      const addr = formatAddr({ col: rect.c0 + j, row: destRow });
      let input = cell.input;
      if (input.startsWith("=")) {
        input = "=" + shiftFormula(input.slice(1), destRow - cell.srcRow, 0);
      }
      sheet.setCell(addr, input);
      sheet.setFormat(addr, Object.keys(cell.format).length > 0 ? cell.format : { bold: null, align: null, numFmt: null });
    });
  });
}

// ---------- structural edits: insert/delete rows & columns (WO-42B) ----------

/** Rewrite every cell reference in a formula body through a mapper.
 *  The mapper returns the new (col,row) or null for #REF!. Everything
 *  else in the body (strings, spacing, operators, function names) is
 *  preserved verbatim — same splice machinery as shiftFormula. */
export function mapRefs(
  body: string,
  mapper: (col: number, row: number) => { col: number; row: number } | null
): string {
  let tokens;
  try {
    tokens = tokenize(body);
  } catch {
    return body;
  }
  const edits: { start: number; end: number; repl: string }[] = [];
  tokens.forEach((tok, i) => {
    if (tok.kind !== "ident") return;
    if (tokens[i + 1]?.kind === "op" && tokens[i + 1]?.text === "(") return;
    const m = REF_RE.exec(tok.text);
    if (!m || !parseAddr(tok.text)) return;
    const colAnchored = m[1] === "$";
    const rowAnchored = m[3] === "$";
    const mapped = mapper(nameToCol(m[2]!), parseInt(m[4]!, 10) - 1);
    const repl = mapped === null
      ? "#REF!"
      : `${colAnchored ? "$" : ""}${colToName(mapped.col)}${rowAnchored ? "$" : ""}${mapped.row + 1}`;
    if (repl !== tok.text) edits.push({ start: tok.pos, end: tok.pos + tok.text.length, repl });
  });
  let out = "";
  let cursor = 0;
  for (const e of edits) {
    out += body.slice(cursor, e.start) + e.repl;
    cursor = e.end;
  }
  return out + body.slice(cursor);
}

/**
 * Insert (count > 0) or delete (count < 0) rows/columns at `at`, shifting
 * everything after, Excel-style: cell contents, formats, and row heights /
 * column widths move; formulas sheet-wide are rewritten — references into a
 * deleted zone become #REF!, references past the zone shift.
 */
export function shiftStructure(sheet: Sheet, axis: "row" | "col", at: number, count: number): void {
  if (count === 0) return;
  const delFrom = count < 0 ? at : Infinity;
  const delTo = count < 0 ? at - count - 1 : -Infinity; // inclusive
  const mapIndex = (i: number): number | null => {
    if (i >= delFrom && i <= delTo) return null; // deleted
    return i >= at ? i + count : i;
  };
  const mapper = (col: number, row: number): { col: number; row: number } | null => {
    const v = axis === "row" ? mapIndex(row) : mapIndex(col);
    if (v === null) return null;
    return axis === "row" ? { col, row: v } : { col: v, row };
  };
  const fix = (col: number, row: number) =>
    axis === "row" ? { col, row: mapIndex(row)! } : { col: mapIndex(col)!, row };

  // snapshot
  const cells = sheet.entries().map((e) => ({ ...e, a: parseAddr(e.addr)! }));
  // wipe
  for (const c of cells) {
    sheet.setCell(c.addr, "");
    sheet.setFormat(c.addr, { bold: null, align: null, numFmt: null, decimals: null, border: null, fill: null, color: null, wrap: null });
  }
  // rewrite + replace
  for (const c of cells) {
    const idx = axis === "row" ? c.a.row : c.a.col;
    if (mapIndex(idx) === null) continue; // the row/col itself was deleted
    const dest = fix(c.a.col, c.a.row);
    let input = c.input;
    if (input.startsWith("=")) input = "=" + mapRefs(input.slice(1), mapper);
    const addr = formatAddr(dest);
    sheet.setCell(addr, input);
    if (c.format && Object.keys(c.format).length > 0) sheet.setFormat(addr, c.format);
  }
  // sizes travel
  if (axis === "row") {
    const hs = sheet.rows();
    for (const h of hs) sheet.setRowHeight(h.row, null);
    for (const h of hs) {
      const to = mapIndex(h.row);
      if (to !== null) sheet.setRowHeight(to, h.height);
    }
  } else {
    const ws = sheet.cols();
    for (const w of ws) sheet.setColWidth(w.col, null);
    for (const w of ws) {
      const to = mapIndex(w.col);
      if (to !== null) sheet.setColWidth(to, w.width);
    }
  }
}
