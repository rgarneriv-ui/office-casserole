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
  TextRun,
} from "./types";
import {
  blockText,
  newId,
  normRange,
  runsSlice,
  sortMarks,
} from "./model";
import { OpRecorder, PrimOp, applyOp } from "./oplog";

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
  const newType: BlockType =
    block.type === "bullet" || block.type === "numbered"
      ? block.type // lists continue on Enter (empty-item exit is a UI rule)
      : block.type !== "paragraph" && remainder > 0
        ? block.type
        : "paragraph";
  emit(
    model,
    {
      t: "split-block",
      block: pos.block,
      offset: pos.offset,
      newBlockId: newId(),
      newBlockType: newType,
      origType: block.type,
    },
    rec
  );
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
  const after: TextRun[] = before.map((r) => ({ text: r.text, marks: sortMarks(fn(r.marks)) }));
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
  for (let b = start.block; b <= end.block; b++) {
    const block = model.blocks[b]!;
    if (block.type === type) continue;
    emit(model, { t: "set-block-type", block: b, before: block.type, after: type }, rec);
  }
}
