/**
 * Serializable, attributed operation journal (spec §14.1: durable operation
 * log with author attribution; §13.2 "durable operation log and snapshots").
 * A journal is a base snapshot plus an ordered list of transactions, each
 * carrying its actor, time, and primitive ops. Replay is deterministic:
 * base + entries always produces the same model, byte-for-byte — which is
 * what makes the log a sync/collaboration substrate rather than a history
 * decoration.
 */

import { DocModel, TextRun } from "./types";
import { validateModel } from "./model";
import { PrimOp, applyOp } from "./oplog";

export interface OpTransaction {
  txnId: string;
  actorId: string;
  /** journal sequence, assigned on append — total order within one journal */
  seq: number;
  at: string; // ISO timestamp
  ops: PrimOp[];
}

export interface JournalData {
  formatVersion: "1.0";
  baseSnapshot: DocModel;
  entries: OpTransaction[];
}

function clone<T>(v: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(v)
    : (JSON.parse(JSON.stringify(v)) as T);
}

let txnCounter = 0;
export function newTxnId(actorId: string): string {
  txnCounter += 1;
  return `${actorId}-${Date.now().toString(36)}-${txnCounter.toString(36)}`;
}

// ---------- validation ----------

function isRuns(v: unknown): v is TextRun[] {
  return (
    Array.isArray(v) &&
    v.every(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as TextRun).text === "string" &&
        Array.isArray((r as TextRun).marks) &&
        (r as TextRun).marks.every((m) => ["bold", "italic", "underline"].includes(m))
    )
  );
}

const BLOCK_TYPES = ["paragraph", "heading1", "heading2", "bullet", "numbered", "table"];

export function validatePrimOp(op: unknown): string[] {
  const errors: string[] = [];
  if (typeof op !== "object" || op === null) return ["op is not an object"];
  const o = op as Record<string, unknown>;
  switch (o.t) {
    case "replace-runs":
      if (!Number.isInteger(o.block) || (o.block as number) < 0) errors.push("replace-runs: bad block");
      if (!Number.isInteger(o.from) || !Number.isInteger(o.to) || (o.from as number) < 0 || (o.to as number) < (o.from as number))
        errors.push("replace-runs: bad range");
      if (!isRuns(o.before) || !isRuns(o.after)) errors.push("replace-runs: bad runs");
      break;
    case "split-block":
      if (!Number.isInteger(o.block) || !Number.isInteger(o.offset)) errors.push("split-block: bad position");
      if (typeof o.newBlockId !== "string" || !o.newBlockId) errors.push("split-block: bad id");
      if (!BLOCK_TYPES.includes(o.newBlockType as string) || !BLOCK_TYPES.includes(o.origType as string))
        errors.push("split-block: bad type");
      break;
    case "merge-blocks":
      if (!Number.isInteger(o.block) || (o.block as number) < 1) errors.push("merge-blocks: bad block");
      if (!Number.isInteger(o.seam) || (o.seam as number) < 0) errors.push("merge-blocks: bad seam");
      if (typeof o.removedId !== "string") errors.push("merge-blocks: bad id");
      if (!BLOCK_TYPES.includes(o.removedType as string) || !BLOCK_TYPES.includes(o.prevType as string))
        errors.push("merge-blocks: bad type");
      break;
    case "set-table": {
      if (!Number.isInteger(o.block)) errors.push("set-table: bad block");
      for (const side of ["beforeType", "afterType"] as const) {
        if (!BLOCK_TYPES.includes(o[side] as string)) errors.push(`set-table: bad ${side}`);
      }
      for (const side of ["beforeTable", "afterTable"] as const) {
        const t = o[side];
        if (t !== null && (!Array.isArray(t) || !(t as unknown[]).every((r) => Array.isArray(r) && (r as unknown[]).every((c) => typeof c === "string"))))
          errors.push(`set-table: bad ${side}`);
      }
      if ((o.afterType === "table") !== (o.afterTable !== null)) errors.push("set-table: afterType/afterTable mismatch");
      if ((o.beforeType === "table") !== (o.beforeTable !== null)) errors.push("set-table: beforeType/beforeTable mismatch");
      break;
    }
    case "set-block-type":
      if (!Number.isInteger(o.block)) errors.push("set-block-type: bad block");
      if (!BLOCK_TYPES.includes(o.before as string) || !BLOCK_TYPES.includes(o.after as string))
        errors.push("set-block-type: bad type");
      for (const k of ["beforeIndent", "afterIndent"]) {
        const v = o[k];
        if (v !== undefined && (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 3))
          errors.push(`set-block-type: bad ${k}`);
      }
      break;
    case "replace-model": {
      for (const side of ["before", "after"] as const) {
        const m = o[side] as DocModel | undefined;
        if (!m || !Array.isArray(m.blocks)) errors.push(`replace-model: bad ${side}`);
      }
      break;
    }
    default:
      errors.push(`unknown op kind ${String(o.t)}`);
  }
  return errors;
}

export function validateTransaction(txn: unknown): string[] {
  const errors: string[] = [];
  if (typeof txn !== "object" || txn === null) return ["txn is not an object"];
  const t = txn as Record<string, unknown>;
  if (typeof t.txnId !== "string" || !t.txnId) errors.push("missing txnId");
  if (typeof t.actorId !== "string" || !t.actorId) errors.push("missing actorId");
  if (!Number.isInteger(t.seq)) errors.push("missing seq");
  if (typeof t.at !== "string" || Number.isNaN(Date.parse(t.at))) errors.push("bad timestamp");
  if (!Array.isArray(t.ops)) errors.push("ops is not an array");
  else t.ops.forEach((op, i) => validatePrimOp(op).forEach((e) => errors.push(`op ${i}: ${e}`)));
  return errors;
}

// ---------- journal ----------

export class DocumentJournal {
  private baseSnapshot: DocModel;
  private entries: OpTransaction[] = [];
  private nextSeq = 1;

  constructor(base: DocModel) {
    this.baseSnapshot = clone(base);
  }

  /** Append an attributed transaction. Ops must already be valid primitives. */
  append(actorId: string, ops: PrimOp[], txnId?: string, at?: string): OpTransaction {
    const txn: OpTransaction = {
      txnId: txnId ?? newTxnId(actorId),
      actorId,
      seq: this.nextSeq++,
      at: at ?? new Date().toISOString(),
      ops: clone(ops),
    };
    const errors = validateTransaction(txn);
    if (errors.length > 0) throw new Error(`invalid transaction: ${errors.join("; ")}`);
    this.entries.push(txn);
    return clone(txn);
  }

  size(): number {
    return this.entries.length;
  }

  list(): OpTransaction[] {
    return clone(this.entries);
  }

  /** Who touched the document, in order — the §14 attribution primitive. */
  actors(): string[] {
    return [...new Set(this.entries.map((e) => e.actorId))];
  }

  /** Deterministic replay: base + entries → model. Never mutates the journal. */
  replay(upToSeq = Infinity): DocModel {
    const model = clone(this.baseSnapshot);
    for (const entry of this.entries) {
      if (entry.seq > upToSeq) break;
      for (const op of entry.ops) applyOp(model, op);
    }
    const errors = validateModel(model);
    if (errors.length > 0) throw new Error(`journal replay produced invalid model: ${errors.join("; ")}`);
    return model;
  }

  /** Fold entries with seq <= upToSeq into the base snapshot (§14.1 compaction). */
  compact(upToSeq: number): void {
    this.baseSnapshot = this.replay(upToSeq);
    this.entries = this.entries.filter((e) => e.seq > upToSeq);
  }

  toJSON(): string {
    const data: JournalData = {
      formatVersion: "1.0",
      baseSnapshot: this.baseSnapshot,
      entries: this.entries,
    };
    return JSON.stringify(data);
  }

  static fromJSON(json: string): DocumentJournal {
    const data = JSON.parse(json) as JournalData;
    if (data.formatVersion !== "1.0") {
      throw new Error(`unsupported journal format ${String(data.formatVersion)}`);
    }
    const baseErrors = validateModel(data.baseSnapshot);
    if (baseErrors.length > 0) throw new Error(`invalid base snapshot: ${baseErrors.join("; ")}`);
    const journal = new DocumentJournal(data.baseSnapshot);
    let lastSeq = 0;
    for (const entry of data.entries ?? []) {
      const errors = validateTransaction(entry);
      if (errors.length > 0) throw new Error(`invalid journal entry: ${errors.join("; ")}`);
      if (entry.seq <= lastSeq) throw new Error("journal entries out of order");
      lastSeq = entry.seq;
      journal.entries.push(clone(entry));
    }
    journal.nextSeq = lastSeq + 1;
    return journal;
  }
}
