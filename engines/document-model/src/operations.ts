/**
 * Editing operations. Since ADR-0009, every operation decomposes into
 * invertible primitives (oplog.ts) and applies them through applyOp — one
 * mutation path for live editing, undo/redo, and (later) collaboration.
 * Each operation optionally records its primitives into an OpRecorder; the
 * returned caret/selection semantics are unchanged from v1.
 */

import {
  Block,
  BlockType,
  DocModel,
  DocRange,
  Mark,
  Position,
  RunProps,
  TextRun,
} from "./types";
import {
  blockText,
  cloneRun,
  newId,
  normRange,
  runsSlice,
  marksAt,
  sortMarks,
} from "./model";
import { OpRecorder, PrimOp, applyOp } from "./oplog";
import type { TableStyle } from "./types";

function emit(model: DocModel, op: PrimOp, rec?: OpRecorder): void {
  rec?.record(op); // record first: recorder deep-copies, apply mutates
  applyOp(model, op);
}

/** Insert text at a position with an explicit mark set. */
export function insertText(
  model: DocModel,
  pos: Position,
  text: string,
  marks: Mark[] = [],
  rec?: OpRecorder
): Position {
  const block = model.blocks[pos.block];
  if (!block) throw new Error(`insertText: no block ${pos.block}`);
  emit(
    model,
    {
      t: "replace-runs",
      block: pos.block,
      from: pos.offset,
      to: pos.offset,
      before: [],
      after: [{ text, marks: sortMarks(marks) }],
    },
    rec
  );
  return { block: pos.block, offset: pos.offset + text.length };
}

/** Delete the content of a (normalized) range, joining blocks when it spans them. */
export function deleteRange(model: DocModel, range: DocRange, rec?: OpRecorder): Position {
  const { start, end } = normRange(range);
  if (start.block === end.block && start.offset === end.offset) return start;

  const first = model.blocks[start.block];
  const last = model.blocks[end.block];
  if (!first || !last) throw new Error("deleteRange: range outside document");

  if (start.block === end.block) {
    emit(
      model,
      {
        t: "replace-runs",
        block: start.block,
        from: start.offset,
        to: end.offset,
        before: runsSlice(first.runs, start.offset, end.offset),
        after: [],
      },
      rec
    );
    return { block: start.block, offset: start.offset };
  }

  // 1) trim the tail of the first block
  emit(
    model,
    {
      t: "replace-runs",
      block: start.block,
      from: start.offset,
      to: blockText(first).length,
      before: runsSlice(first.runs, start.offset, blockText(first).length),
      after: [],
    },
    rec
  );
  // 2) empty every intermediate block and the head of the last block
  for (let b = start.block + 1; b < end.block; b++) {
    const blk = model.blocks[b]!;
    emit(
      model,
      {
        t: "replace-runs",
        block: b,
        from: 0,
        to: blockText(blk).length,
        before: runsSlice(blk.runs, 0, blockText(blk).length),
        after: [],
      },
      rec
    );
  }
  emit(
    model,
    {
      t: "replace-runs",
      block: end.block,
      from: 0,
      to: end.offset,
      before: runsSlice(model.blocks[end.block]!.runs, 0, end.offset),
      after: [],
    },
    rec
  );
  // 3) structurally merge the (now empty) blocks into the first, left to right
  const firstType = model.blocks[start.block]!.type;
  for (let b = end.block; b > start.block; b--) {
    const victim = model.blocks[start.block + 1]!;
    emit(
      model,
      {
        t: "merge-blocks",
        block: start.block + 1,
        seam: start.offset,
        removedId: victim.id,
        removedType: victim.type,
        prevType: firstType,
      },
      rec
    );
  }
  return { block: start.block, offset: start.offset };
}

/** Enter: split a block at the caret. A split heading continues as a paragraph. */
export function splitBlock(model: DocModel, pos: Position, rec?: OpRecorder): Position {
  const block = model.blocks[pos.block];
  if (!block) throw new Error(`splitBlock: no block ${pos.block}`);
  const remainder = blockText(block).length - pos.offset;
  const isList = block.type === "bullet" || block.type === "numbered";
  const newType: BlockType = isList
    ? block.type // lists continue on Enter (empty-item exit is a UI rule)
    : block.type !== "paragraph" && remainder > 0
      ? block.type
      : "paragraph";
  const op: PrimOp = {
    t: "split-block",
    block: pos.block,
    offset: pos.offset,
    newBlockId: newId(),
    newBlockType: newType,
    origType: block.type,
  };
  if (isList && block.indent) op.newIndent = block.indent; // inherit nesting
  emit(model, op, rec);
  return { block: pos.block + 1, offset: 0 };
}

/** Backspace at block start: merge a block into the previous one. */
export function mergeWithPrevious(model: DocModel, blockIndex: number, rec?: OpRecorder): Position {
  if (blockIndex <= 0) return { block: 0, offset: 0 };
  const prev = model.blocks[blockIndex - 1]!;
  const cur = model.blocks[blockIndex]!;
  const caretOffset = blockText(prev).length;
  emit(
    model,
    {
      t: "merge-blocks",
      block: blockIndex,
      seam: caretOffset,
      removedId: cur.id,
      removedType: cur.type,
      prevType: prev.type,
    },
    rec
  );
  return { block: blockIndex - 1, offset: caretOffset };
}

/** True when every character in the range carries the mark. */
export function rangeHasMark(model: DocModel, range: DocRange, mark: Mark): boolean {
  const { start, end } = normRange(range);
  for (let b = start.block; b <= end.block; b++) {
    const block = model.blocks[b]!;
    const from = b === start.block ? start.offset : 0;
    const to = b === end.block ? end.offset : blockText(block).length;
    if (to <= from) continue;
    const slice = runsSlice(block.runs, from, to);
    for (const run of slice) {
      if (!run.marks.includes(mark)) return false;
    }
  }
  return true;
}

function mapMarksOp(
  block: Block,
  blockIndex: number,
  from: number,
  to: number,
  fn: (marks: Mark[]) => Mark[]
): PrimOp | null {
  if (to <= from) return null;
  const before = runsSlice(block.runs, from, to);
  const after: TextRun[] = before.map((r) => { const c = cloneRun(r); c.marks = sortMarks(fn(r.marks)); return c; });
  return { t: "replace-runs", block: blockIndex, from, to, before, after };
}

/** Word-style toggle: if the whole range already has the mark, remove it; else apply it. */
export function toggleMark(model: DocModel, range: DocRange, mark: Mark, rec?: OpRecorder): void {
  const { start, end } = normRange(range);
  const removing = rangeHasMark(model, range, mark);
  for (let b = start.block; b <= end.block; b++) {
    const block = model.blocks[b]!;
    const from = b === start.block ? start.offset : 0;
    const to = b === end.block ? end.offset : blockText(block).length;
    const op = mapMarksOp(block, b, from, to, (marks) =>
      removing ? marks.filter((m) => m !== mark) : marks.includes(mark) ? marks : [...marks, mark]
    );
    if (op) emit(model, op, rec);
  }
}

/** Set the block type for every block the range touches. */
export function setBlockType(
  model: DocModel,
  range: DocRange,
  type: BlockType,
  rec?: OpRecorder
): void {
  const { start, end } = normRange(range);
  const typeIsList = type === "bullet" || type === "numbered";
  for (let b = start.block; b <= end.block; b++) {
    const block = model.blocks[b]!;
    if (block.type === type) continue;
    const op: PrimOp = { t: "set-block-type", block: b, before: block.type, after: type };
    if (block.indent) op.beforeIndent = block.indent;
    if (typeIsList && block.indent) op.afterIndent = block.indent; // keep level across bullet<->numbered
    emit(model, op, rec);
  }
}

/** Tab / Shift-Tab: change list nesting by delta, clamped to 0–3. Non-list
 *  blocks in the range are left alone. */
export function setListIndent(
  model: DocModel,
  range: DocRange,
  delta: 1 | -1,
  rec?: OpRecorder
): void {
  const { start, end } = normRange(range);
  for (let b = start.block; b <= end.block; b++) {
    const block = model.blocks[b]!;
    if (block.type !== "bullet" && block.type !== "numbered") continue;
    const cur = block.indent ?? 0;
    const next = Math.max(0, Math.min(3, cur + delta));
    if (next === cur) continue;
    const op: PrimOp = { t: "set-block-type", block: b, before: block.type, after: block.type };
    if (cur) op.beforeIndent = cur;
    if (next) op.afterIndent = next;
    emit(model, op, rec);
  }
}

// ---------- tables (atomic blocks, ADR-0011) ----------

function cloneStyle(style: TableStyle | undefined): TableStyle | null {
  return style ? (JSON.parse(JSON.stringify(style)) as TableStyle) : null;
}

function tableOp(
  model: DocModel,
  blockIndex: number,
  afterType: BlockType,
  afterTable: string[][] | null,
  rec?: OpRecorder,
  afterStyle?: TableStyle | null
): void {
  const block = model.blocks[blockIndex];
  if (!block) throw new Error(`tableOp: no block ${blockIndex}`);
  const op: PrimOp = {
    t: "set-table",
    block: blockIndex,
    beforeType: block.type,
    afterType,
    beforeTable: block.table ? block.table.map((r) => [...r]) : null,
    afterTable,
    beforeRuns: block.runs.map((r) => cloneRun(r)),
  };
  const before = cloneStyle(block.tableStyle);
  const after = afterTable === null ? null : afterStyle !== undefined ? afterStyle : before;
  if (before !== null) op.beforeStyle = before;
  if (after !== null && after !== undefined) op.afterStyle = after;
  emit(model, op, rec);
}

/** Insert an empty rows×cols table after the caret block; returns the caret
 *  position (the paragraph created after the table). */
export function insertTable(
  model: DocModel,
  pos: Position,
  rows: number,
  cols: number,
  rec?: OpRecorder
): Position {
  const block = model.blocks[pos.block];
  if (!block) throw new Error(`insertTable: no block ${pos.block}`);
  const data: string[][] = Array.from({ length: Math.max(1, rows) }, () =>
    new Array<string>(Math.max(1, cols)).fill("")
  );
  const end = blockText(block).length;
  // split twice at the end: [..block][tableSlot][after]; caret lands on after
  splitBlock(model, { block: pos.block, offset: end }, rec);
  splitBlock(model, { block: pos.block + 1, offset: 0 }, rec);
  tableOp(model, pos.block + 1, "table", data, rec, { headerRow: true });
  return { block: pos.block + 2, offset: 0 };
}

export function setTableCell(
  model: DocModel,
  blockIndex: number,
  row: number,
  col: number,
  text: string,
  rec?: OpRecorder
): void {
  const table = model.blocks[blockIndex]?.table;
  if (!table || !table[row] || col >= table[row]!.length) {
    throw new Error(`setTableCell: no cell ${row},${col} in block ${blockIndex}`);
  }
  if (table[row]![col] === text) return;
  const next = table.map((r) => [...r]);
  next[row]![col] = text;
  tableOp(model, blockIndex, "table", next, rec);
}

export type TableEdit = "add-row" | "remove-row" | "add-col" | "remove-col";

export function editTable(
  model: DocModel,
  blockIndex: number,
  edit: TableEdit,
  rec?: OpRecorder
): void {
  const table = model.blocks[blockIndex]?.table;
  if (!table) throw new Error(`editTable: block ${blockIndex} is not a table`);
  let next = table.map((r) => [...r]);
  const style = model.blocks[blockIndex]!.tableStyle
    ? (JSON.parse(JSON.stringify(model.blocks[blockIndex]!.tableStyle)) as TableStyle)
    : undefined;
  if (edit === "add-row") next.push(new Array<string>(next[0]!.length).fill(""));
  else if (edit === "remove-row" && next.length > 1) next = next.slice(0, -1);
  else if (edit === "add-col") {
    next = next.map((r) => [...r, ""]);
    if (style?.aligns) style.aligns.push(null);
    if (style?.widths) style.widths.push(1);
  } else if (edit === "remove-col" && next[0]!.length > 1) {
    next = next.map((r) => r.slice(0, -1));
    if (style?.aligns) style.aligns.pop();
    if (style?.widths) style.widths.pop();
  } else return; // removing the last row/col is a no-op, not a crash
  tableOp(model, blockIndex, "table", next, rec, style ?? null);
}

/** Merge a style patch into a table's presentation. Per-column arrays are
 *  normalized to the column count. */
export function setTableStyle(
  model: DocModel,
  blockIndex: number,
  patch: Partial<TableStyle>,
  rec?: OpRecorder
): void {
  const block = model.blocks[blockIndex];
  if (!block?.table) throw new Error(`setTableStyle: block ${blockIndex} is not a table`);
  const cols = block.table[0]!.length;
  const cur: TableStyle = block.tableStyle
    ? (JSON.parse(JSON.stringify(block.tableStyle)) as TableStyle)
    : {};
  const next: TableStyle = { ...cur, ...patch };
  if (next.headerRow === false) delete next.headerRow;
  if (next.aligns) {
    next.aligns = next.aligns.slice(0, cols);
    while (next.aligns.length < cols) next.aligns.push(null);
    if (next.aligns.every((a) => a === null)) delete next.aligns;
  }
  if (next.widths) {
    next.widths = next.widths.slice(0, cols).map((w) => Math.max(0.2, w));
    while (next.widths.length < cols) next.widths.push(1);
  }
  tableOp(model, blockIndex, "table", block.table.map((r) => [...r]), rec,
    Object.keys(next).length > 0 ? next : null);
}

/** Convert a table back to an empty paragraph (content intentionally dropped —
 *  callers confirm with the user first). */
export function removeTable(model: DocModel, blockIndex: number, rec?: OpRecorder): void {
  const block = model.blocks[blockIndex];
  if (!block?.table) return;
  const op: PrimOp = {
    t: "set-table",
    block: blockIndex,
    beforeType: "table",
    afterType: "paragraph",
    beforeTable: block.table.map((r) => [...r]),
    afterTable: null,
    beforeRuns: [],
  };
  const before = cloneStyle(block.tableStyle);
  if (before !== null) op.beforeStyle = before;
  emit(model, op, rec);
}

// ---------- find & replace (WO-37) ----------

export interface TextMatch {
  block: number;
  from: number;
  to: number;
}

/**
 * Plain-text search over paragraph-family blocks (tables are atomic and not
 * searched — see registry known limitations). Matches never cross blocks.
 */
export function findMatches(model: DocModel, query: string, matchCase = false): TextMatch[] {
  if (query.length === 0) return [];
  const needle = matchCase ? query : query.toLowerCase();
  const out: TextMatch[] = [];
  model.blocks.forEach((block, bi) => {
    if (block.type === "table") return;
    const hay = matchCase ? blockText(block) : blockText(block).toLowerCase();
    let at = hay.indexOf(needle);
    while (at >= 0) {
      out.push({ block: bi, from: at, to: at + query.length });
      at = hay.indexOf(needle, at + Math.max(1, query.length));
    }
  });
  return out;
}

/** Replace one match with plain text carrying the marks at the match start.
 *  A single invertible replace-runs primitive — journaled like any edit. */
export function replaceMatch(
  model: DocModel,
  m: TextMatch,
  replacement: string,
  rec?: OpRecorder
): Position {
  const block = model.blocks[m.block];
  if (!block) throw new Error(`replaceMatch: no block ${m.block}`);
  // marks of the first replaced character (marksAt is caret-style: it looks
  // left of the offset, so probe one past the match start)
  const marks = marksAt(block, Math.min(m.from + 1, m.to));
  emit(
    model,
    {
      t: "replace-runs",
      block: m.block,
      from: m.from,
      to: m.to,
      before: runsSlice(block.runs, m.from, m.to),
      after: replacement.length > 0 ? [{ text: replacement, marks }] : [],
    },
    rec
  );
  return { block: m.block, offset: m.from + replacement.length };
}

/** Replace every match (back-to-front so offsets stay valid). Returns count. */
export function replaceAll(
  model: DocModel,
  query: string,
  replacement: string,
  matchCase = false,
  rec?: OpRecorder
): number {
  const matches = findMatches(model, query, matchCase);
  for (let i = matches.length - 1; i >= 0; i--) {
    replaceMatch(model, matches[i]!, replacement, rec);
  }
  return matches.length;
}

// ---------- run properties + block attributes (WO-42A) ----------

export type RunPropPatch = Partial<Record<keyof RunProps, string | number | null>>;

/** Apply character properties (size, color, highlight, font, link) to a
 *  range. Splits runs at the boundaries; each changed block is one
 *  invertible replace-runs primitive. `null` clears a property. */
export function setRunProps(
  model: DocModel,
  range: DocRange,
  patch: RunPropPatch,
  rec?: OpRecorder
): void {
  const { start, end } = normRange(range);
  for (let b = start.block; b <= end.block; b++) {
    const block = model.blocks[b];
    if (!block || block.type === "table") continue;
    const from = b === start.block ? start.offset : 0;
    const to = b === end.block ? end.offset : blockText(block).length;
    if (from >= to) continue;
    const before = runsSlice(block.runs, from, to);
    const after = before.map((r) => {
      const next = { ...r, marks: [...r.marks] } as TextRun;
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined) delete (next as unknown as Record<string, unknown>)[k];
        else (next as unknown as Record<string, unknown>)[k] = v;
      }
      return next;
    });
    emit(model, { t: "replace-runs", block: b, from, to, before, after }, rec);
  }
}

/** The run properties in force just before `offset` (toolbar sync). */
export function runPropsAt(block: Block, offset: number): RunProps {
  let consumed = 0;
  for (const run of block.runs) {
    const end = consumed + run.text.length;
    if (offset <= end && offset > consumed) {
      const { size, color, highlight, font, link } = run;
      return { size, color, highlight, font, link };
    }
    consumed = end;
  }
  const r = offset === 0 ? block.runs[0] : block.runs[block.runs.length - 1];
  if (!r) return {};
  const { size, color, highlight, font, link } = r;
  return { size, color, highlight, font, link };
}

/** Set a block attribute (align / spacing / pageBreakBefore) over the blocks
 *  a range touches. One invertible set-block-attr primitive per block. */
export function setBlockAttr(
  model: DocModel,
  range: DocRange,
  key: "align" | "spacing" | "pageBreakBefore",
  value: unknown,
  rec?: OpRecorder
): void {
  const { start, end } = normRange(range);
  for (let b = start.block; b <= end.block; b++) {
    const block = model.blocks[b];
    if (!block) continue;
    const before = (block as unknown as Record<string, unknown>)[key];
    const normalized = value === "left" && key === "align" ? undefined : value === 1 && key === "spacing" ? undefined : value || undefined;
    if (before === normalized) continue;
    emit(model, { t: "set-block-attr", block: b, key, before, after: normalized ?? null }, rec);
  }
}
