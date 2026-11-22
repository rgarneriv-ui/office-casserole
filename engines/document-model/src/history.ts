/**
 * Undo/redo (ADR-0003): transaction snapshots with typing coalescing.
 * v0 stores whole-model snapshots per transaction — correct and simple for
 * documents of this slice's size. The recorded migration path is per-operation
 * inverse logs once collaboration lands (spec §14.1).
 */

import { DocModel } from "./types";


export interface HistoryEntry<T> {
  model: T;
  /** Coalescing key: consecutive checkpoints with the same key within the
   *  coalescing window collapse into one undo step. */
  key: string | null;
  at: number;
}

const COALESCE_MS = 1000;

function clone<T>(model: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(model)
    : (JSON.parse(JSON.stringify(model)) as T);
}

export class History<T = DocModel> {
  private undoStack: HistoryEntry<T>[] = [];
  private redoStack: HistoryEntry<T>[] = [];
  private limit: number;

  constructor(limit = 200) {
    this.limit = limit;
  }

  /** Record the pre-change state. Call before applying a transaction. */
  checkpoint(model: T, key: string | null = null, now = Date.now()): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (key !== null && top && top.key === key && now - top.at < COALESCE_MS) {
      top.at = now; // extend the coalescing window; keep the earlier snapshot
      this.redoStack = [];
      return;
    }
    this.undoStack.push({ model: clone(model), key, at: now });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Returns the model state to restore, or null. `current` goes to the redo stack. */
  undo(current: T): T | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push({ model: clone(current), key: null, at: Date.now() });
    return clone(entry.model);
  }

  redo(current: T): T | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push({ model: clone(current), key: null, at: Date.now() });
    return clone(entry.model);
  }
}
