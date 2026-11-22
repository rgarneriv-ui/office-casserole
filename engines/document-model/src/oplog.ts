/**
 * Operation log (ADR-0009): the ADR-0001/0003 migration from snapshot undo
 * to per-operation inverse logs — the §14.1 foundation for collaboration.
 *
 * Every mutation of the document is expressed as one of a small set of
 * PRIMITIVE operations, each of which is exactly invertible. High-level
 * editing (operations.ts) decomposes into these primitives and records them;
 * undo applies inverses in reverse order, redo re-applies the originals.
 * Because primitives carry the ids and content they create or remove,
 * undo→redo round-trips are byte-stable (ids included) — proven by property
 * tests, not asserted.
 */

import { Block, BlockType, DocModel, TextRun } from "./types";
import { normalizeBlock, normalizeModel, splitRunsAt } from "./model";

export type PrimOp =
  | {
      t: "replace-runs";
      block: number;
      /** character range [from, to) in the block's plain text */
      from: number;
      to: number;
      before: TextRun[];
      after: TextRun[];
    }
  | {
      t: "split-block";
      block: number;
      offset: number;
      newBlockId: string;
      newBlockType: BlockType;
      /** type of the block being split (bookkeeping for the inverse) */
      origType: BlockType;
    }
  | {
      t: "merge-blocks";
      /** index of the block merged into its predecessor */
      block: number;
      /** character offset in the predecessor where the seam sits */
      seam: number;
      removedId: string;
      removedType: BlockType;
      prevType: BlockType;
    }
  | { t: "set-block-type"; block: number; before: BlockType; after: BlockType }
  | { t: "replace-model"; before: DocModel; after: DocModel };

export interface OpRecorder {
  record(op: PrimOp): void;
}

function runsText(runs: TextRun[]): number {
  return runs.reduce((n, r) => n + r.text.length, 0);
}

function cloneRuns(runs: TextRun[]): TextRun[] {
  return runs.map((r) => ({ text: r.text, marks: [...r.marks] }));
}

function cloneModel(model: DocModel): DocModel {
  return typeof structuredClone === "function"
    ? structuredClone(model)
    : (JSON.parse(JSON.stringify(model)) as DocModel);
}

/** Apply a primitive to the model in place. Throws on structural impossibility. */
export function applyOp(model: DocModel, op: PrimOp): void {
  switch (op.t) {
    case "replace-runs": {
      const block = model.blocks[op.block];
      if (!block) throw new Error(`applyOp: no block ${op.block}`);
      const [left, rest] = splitRunsAt(block.runs, op.from);
      const [, right] = splitRunsAt(rest, op.to - op.from);
      block.runs = [...left, ...cloneRuns(op.after), ...right];
      normalizeBlock(block);
      break;
    }
    case "split-block": {
      const block = model.blocks[op.block];
      if (!block) throw new Error(`applyOp: no block ${op.block}`);
      const [left, right] = splitRunsAt(block.runs, op.offset);
      block.runs = left;
      normalizeBlock(block);
      const next: Block = { id: op.newBlockId, type: op.newBlockType, runs: right };
      normalizeBlock(next);
      model.blocks.splice(op.block + 1, 0, next);
      break;
    }
    case "merge-blocks": {
      const prev = model.blocks[op.block - 1];
      const cur = model.blocks[op.block];
      if (!prev || !cur) throw new Error(`applyOp: cannot merge block ${op.block}`);
      prev.runs = [...prev.runs, ...cur.runs];
      normalizeBlock(prev);
      model.blocks.splice(op.block, 1);
      break;
    }
    case "set-block-type": {
      const block = model.blocks[op.block];
      if (!block) throw new Error(`applyOp: no block ${op.block}`);
      block.type = op.after;
      break;
    }
    case "replace-model": {
      const next = cloneModel(op.after);
      model.schemaVersion = next.schemaVersion;
      model.blocks.splice(0, model.blocks.length, ...next.blocks);
      normalizeModel(model);
      break;
    }
  }
}

/** The exact inverse of a primitive. invert(invert(op)) ≡ op. */
export function invertOp(op: PrimOp): PrimOp {
  switch (op.t) {
    case "replace-runs":
      return {
        t: "replace-runs",
        block: op.block,
        from: op.from,
        to: op.from + runsText(op.after),
        before: op.after,
        after: op.before,
      };
    case "split-block":
      return {
        t: "merge-blocks",
        block: op.block + 1,
        seam: op.offset,
        removedId: op.newBlockId,
        removedType: op.newBlockType,
        prevType: op.origType,
      };
    case "merge-blocks":
      return {
        t: "split-block",
        block: op.block - 1,
        offset: op.seam,
        newBlockId: op.removedId,
        newBlockType: op.removedType,
        origType: op.prevType,
      };
    case "set-block-type":
      return { t: "set-block-type", block: op.block, before: op.after, after: op.before };
    case "replace-model":
      return { t: "replace-model", before: op.after, after: op.before };
  }
}

// ---------- transaction log ----------

interface Txn {
  ops: PrimOp[];
  key: string | null;
  at: number;
}

const COALESCE_MS = 1000;

export class TransactionLog implements OpRecorder {
  private undoStack: Txn[] = [];
  private redoStack: Txn[] = [];
  private current: Txn | null = null;
  private limit: number;

  constructor(limit = 500) {
    this.limit = limit;
  }

  /** Start a transaction. Consecutive begins with the same key inside the
   *  coalescing window extend the previous transaction (one undo step). */
  begin(key: string | null = null, now = Date.now()): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      key !== null &&
      top &&
      top.key === key &&
      now - top.at < COALESCE_MS &&
      this.redoStack.length === 0
    ) {
      this.current = top;
      top.at = now;
    } else {
      this.current = { ops: [], key, at: now };
      this.undoStack.push(this.current);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.redoStack = [];
  }

  record(op: PrimOp): void {
    if (!this.current) {
      throw new Error("TransactionLog.record outside a transaction (call begin first)");
    }
    // deep-copy run/model payloads so later mutations cannot alias log state
    this.current.ops.push(structuredCloneOp(op));
  }

  canUndo(): boolean {
    return this.undoStack.some((t) => t.ops.length > 0);
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Undo the last non-empty transaction against the model in place. */
  undo(model: DocModel): boolean {
    for (;;) {
      const txn = this.undoStack.pop();
      if (!txn) return false;
      this.current = null;
      if (txn.ops.length === 0) continue;
      for (let i = txn.ops.length - 1; i >= 0; i--) {
        applyOp(model, invertOp(txn.ops[i]!));
      }
      this.redoStack.push(txn);
      return true;
    }
  }

  redo(model: DocModel): boolean {
    const txn = this.redoStack.pop();
    if (!txn) return false;
    for (const op of txn.ops) applyOp(model, op);
    this.undoStack.push({ ...txn, key: null, at: Date.now() });
    this.current = null;
    return true;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.current = null;
  }

  /** Number of committed (non-empty) transactions — for tests/inspection. */
  depth(): number {
    return this.undoStack.filter((t) => t.ops.length > 0).length;
  }
}

function structuredCloneOp(op: PrimOp): PrimOp {
  return typeof structuredClone === "function"
    ? structuredClone(op)
    : (JSON.parse(JSON.stringify(op)) as PrimOp);
}
