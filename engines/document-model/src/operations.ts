/**
 * Editing operations. Each operation mutates the model in place, re-normalizes
 * the affected blocks, and returns the resulting caret/selection. Undo is
 * handled at the dispatch layer (history.ts) — see ADR-0003.
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
  marksEqual,
  newBlock,
  normalizeBlock,
  normalizeModel,
  normRange,
  runsSlice,
  sortMarks,
  splitRunsAt,
} from "./model";

/** Insert text at a position with an explicit mark set. */
export function insertText(
  model: DocModel,
  pos: Position,
  text: string,
  marks: Mark[] = []
): Position {
  const block = model.blocks[pos.block];
  if (!block) throw new Error(`insertText: no block ${pos.block}`);
  const [left, right] = splitRunsAt(block.runs, pos.offset);
  block.runs = [...left, { text, marks: sortMarks(marks) }, ...right];
  normalizeBlock(block);
  return { block: pos.block, offset: pos.offset + text.length };
}

/** Delete the content of a (normalized) range, joining blocks when it spans them. */
export function deleteRange(model: DocModel, range: DocRange): Position {
  const { start, end } = normRange(range);
  if (start.block === end.block && start.offset === end.offset) return start;

  const first = model.blocks[start.block];
  const last = model.blocks[end.block];
  if (!first || !last) throw new Error("deleteRange: range outside document");

  if (start.block === end.block) {
    const [left] = splitRunsAt(first.runs, start.offset);
    const [, right] = splitRunsAt(first.runs, end.offset);
    first.runs = [...left, ...right];
    normalizeBlock(first);
  } else {
    const [left] = splitRunsAt(first.runs, start.offset);
    const [, right] = splitRunsAt(last.runs, end.offset);
    first.runs = [...left, ...right];
    normalizeBlock(first);
    model.blocks.splice(start.block + 1, end.block - start.block);
  }
  normalizeModel(model);
  return { block: start.block, offset: start.offset };
}

/** Enter: split a block at the caret. A split heading continues as a paragraph. */
export function splitBlock(model: DocModel, pos: Position): Position {
  const block = model.blocks[pos.block];
  if (!block) throw new Error(`splitBlock: no block ${pos.block}`);
  const [left, right] = splitRunsAt(block.runs, pos.offset);
  block.runs = left;
  normalizeBlock(block);
  const nextType: BlockType = block.type === "paragraph" ? "paragraph" : "paragraph";
  const next = newBlock(right.length > 0 ? block.type === "paragraph" ? "paragraph" : nextType : nextType, right);
  // Splitting mid-heading keeps heading text style only for the remainder when
  // the user split mid-text; an Enter at the end of a heading starts a paragraph.
  if (block.type !== "paragraph" && right.length > 0) next.type = block.type;
  normalizeBlock(next);
  model.blocks.splice(pos.block + 1, 0, next);
  return { block: pos.block + 1, offset: 0 };
}

/** Backspace at block start: merge a block into the previous one. */
export function mergeWithPrevious(model: DocModel, blockIndex: number): Position {
  if (blockIndex <= 0) return { block: 0, offset: 0 };
  const prev = model.blocks[blockIndex - 1]!;
  const cur = model.blocks[blockIndex]!;
  const caretOffset = blockText(prev).length;
  prev.runs = [...prev.runs, ...cur.runs];
  normalizeBlock(prev);
  model.blocks.splice(blockIndex, 1);
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

function mapMarksInBlock(
  block: Block,
  from: number,
  to: number,
  fn: (marks: Mark[]) => Mark[]
): void {
  if (to <= from) return;
  const [left, rest] = splitRunsAt(block.runs, from);
  const [middle, right] = splitRunsAt(rest, to - from);
  const mapped: TextRun[] = middle.map((r) => ({ text: r.text, marks: sortMarks(fn(r.marks)) }));
  block.runs = [...left, ...mapped, ...right];
  normalizeBlock(block);
}

/** Word-style toggle: if the whole range already has the mark, remove it; else apply it. */
export function toggleMark(model: DocModel, range: DocRange, mark: Mark): void {
  const { start, end } = normRange(range);
  const removing = rangeHasMark(model, range, mark);
  for (let b = start.block; b <= end.block; b++) {
    const block = model.blocks[b]!;
    const from = b === start.block ? start.offset : 0;
    const to = b === end.block ? end.offset : blockText(block).length;
    mapMarksInBlock(block, from, to, (marks) =>
      removing ? marks.filter((m) => m !== mark) : marks.includes(mark) ? marks : [...marks, mark]
    );
  }
}

/** Set the block type for every block the range touches. */
export function setBlockType(model: DocModel, range: DocRange, type: BlockType): void {
  const { start, end } = normRange(range);
  for (let b = start.block; b <= end.block; b++) {
    model.blocks[b]!.type = type;
  }
}
