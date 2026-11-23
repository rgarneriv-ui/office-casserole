/**
 * Model construction, invariants, normalization, and run arithmetic.
 * Every editing operation must leave the model in a state where
 * validateModel() returns no errors (§5.1 document integrity).
 */

import {
  Block,
  BlockType,
  DocModel,
  DocRange,
  Mark,
  Position,
  SCHEMA_VERSION,
  TextRun,
} from "./types";

let idCounter = 0;
export function newId(): string {
  idCounter += 1;
  return `b${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function newBlock(type: BlockType = "paragraph", runs: TextRun[] = []): Block {
  return { id: newId(), type, runs };
}

export function newDocument(): DocModel {
  return { schemaVersion: SCHEMA_VERSION, blocks: [newBlock()] };
}

export function blockText(block: Block): string {
  return block.runs.map((r) => r.text).join("");
}

export function docText(model: DocModel): string {
  return model.blocks.map(blockText).join("\n");
}

export function marksEqual(a: Mark[], b: Mark[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((m, i) => m === sb[i]);
}

export function sortMarks(marks: Mark[]): Mark[] {
  const order: Mark[] = ["bold", "italic", "underline"];
  return order.filter((m) => marks.includes(m));
}

/** Merge adjacent runs with equal marks; drop empty runs; sort marks. */
export function normalizeBlock(block: Block): void {
  const out: TextRun[] = [];
  for (const run of block.runs) {
    if (run.text.length === 0) continue;
    const marks = sortMarks(run.marks);
    const prev = out[out.length - 1];
    if (prev && marksEqual(prev.marks, marks)) {
      prev.text += run.text;
    } else {
      out.push({ text: run.text, marks });
    }
  }
  block.runs = out;
}

export function normalizeModel(model: DocModel): void {
  for (const block of model.blocks) normalizeBlock(block);
  if (model.blocks.length === 0) model.blocks.push(newBlock());
}

/** Invariant checks. Returns a list of human-readable violations (empty = valid). */
export function validateModel(model: DocModel): string[] {
  const errors: string[] = [];
  if (model.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion ${model.schemaVersion}`);
  }
  if (model.blocks.length === 0) errors.push("document has no blocks");
  const seen = new Set<string>();
  model.blocks.forEach((b, i) => {
    if (!b.id) errors.push(`block ${i} missing id`);
    if (seen.has(b.id)) errors.push(`duplicate block id ${b.id}`);
    seen.add(b.id);
    if (b.type === "table") {
      if (b.runs.length > 0) errors.push(`block ${i}: table blocks carry no runs`);
      const t = b.table;
      if (!t || t.length === 0 || t[0]!.length === 0) errors.push(`block ${i}: empty table`);
      else if (!t.every((row) => row.length === t[0]!.length && row.every((c) => typeof c === "string")))
        errors.push(`block ${i}: table is not rectangular`);
      else if (b.tableStyle) {
        const cols = t[0]!.length;
        if (b.tableStyle.aligns && b.tableStyle.aligns.length !== cols)
          errors.push(`block ${i}: tableStyle.aligns length mismatch`);
        if (b.tableStyle.widths) {
          if (b.tableStyle.widths.length !== cols)
            errors.push(`block ${i}: tableStyle.widths length mismatch`);
          else if (!b.tableStyle.widths.every((w) => typeof w === "number" && w > 0))
            errors.push(`block ${i}: tableStyle.widths must be positive`);
        }
      }
    } else if (b.table !== undefined || b.tableStyle !== undefined) {
      errors.push(`block ${i}: non-table block carries table data`);
    }
    if (b.indent !== undefined) {
      if (b.type !== "bullet" && b.type !== "numbered")
        errors.push(`block ${i}: indent on a non-list block`);
      else if (!Number.isInteger(b.indent) || b.indent < 0 || b.indent > 3)
        errors.push(`block ${i}: indent out of range`);
    }
    b.runs.forEach((r, j) => {
      if (r.text.length === 0) errors.push(`block ${i} run ${j} is empty`);
    });
    for (let j = 1; j < b.runs.length; j++) {
      const a = b.runs[j - 1]!;
      const c = b.runs[j]!;
      if (marksEqual(a.marks, c.marks)) {
        errors.push(`block ${i} runs ${j - 1},${j} not merged`);
      }
    }
  });
  return errors;
}

export function cmpPos(a: Position, b: Position): number {
  if (a.block !== b.block) return a.block - b.block;
  return a.offset - b.offset;
}

/** Ordered [start, end] from a possibly-backward range. */
export function normRange(range: DocRange): { start: Position; end: Position } {
  return cmpPos(range.anchor, range.focus) <= 0
    ? { start: range.anchor, end: range.focus }
    : { start: range.focus, end: range.anchor };
}

export function isCollapsed(range: DocRange): boolean {
  return cmpPos(range.anchor, range.focus) === 0;
}

export function clampPosition(model: DocModel, pos: Position): Position {
  const block = Math.max(0, Math.min(pos.block, model.blocks.length - 1));
  const len = blockText(model.blocks[block]!).length;
  const offset = Math.max(0, Math.min(pos.offset, len));
  return { block, offset };
}

/** Split a run array at a character offset → [left, right]. Deep-copies runs. */
export function splitRunsAt(runs: TextRun[], offset: number): [TextRun[], TextRun[]] {
  const left: TextRun[] = [];
  const right: TextRun[] = [];
  let consumed = 0;
  for (const run of runs) {
    const start = consumed;
    const end = consumed + run.text.length;
    if (end <= offset) {
      left.push({ text: run.text, marks: [...run.marks] });
    } else if (start >= offset) {
      right.push({ text: run.text, marks: [...run.marks] });
    } else {
      const cut = offset - start;
      left.push({ text: run.text.slice(0, cut), marks: [...run.marks] });
      right.push({ text: run.text.slice(cut), marks: [...run.marks] });
    }
    consumed = end;
  }
  return [left, right];
}

/** Deep copy of the run content between two offsets within one block. */
export function runsSlice(runs: TextRun[], start: number, end: number): TextRun[] {
  const [, fromStart] = splitRunsAt(runs, start);
  const [middle] = splitRunsAt(fromStart, end - start);
  return middle;
}

/** The mark set in force just before `offset` (used for caret-mark inheritance). */
export function marksAt(block: Block, offset: number): Mark[] {
  if (block.runs.length === 0) return [];
  let consumed = 0;
  for (const run of block.runs) {
    const end = consumed + run.text.length;
    if (offset <= end && offset > consumed) return [...run.marks];
    consumed = end;
  }
  if (offset === 0) return [...block.runs[0]!.marks];
  return [...block.runs[block.runs.length - 1]!.marks];
}
