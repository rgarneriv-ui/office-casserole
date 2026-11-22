/**
 * Block-level document comparison (spec §14.2 revisions layer, §6.2.6
 * "compare formatting between document versions").
 * Blocks are matched by their stable ids (which survive editing) via LCS, so
 * moves/edits don't cascade into spurious add/remove pairs; matched blocks
 * are then compared by content, distinguishing text changes from
 * formatting-only changes (§6.3's comparison requirement, applied at block
 * granularity).
 */

import { Block, DocModel } from "./types";
import { blockText, marksEqual } from "./model";

export type BlockDiffKind = "unchanged" | "changed" | "added" | "removed";

export interface BlockDiffEntry {
  kind: BlockDiffKind;
  /** index in the old document (absent for added) */
  a?: number;
  /** index in the new document (absent for removed) */
  b?: number;
  /** for changed: whether the plain text differs, or only formatting */
  textChanged?: boolean;
  formattingChanged?: boolean;
}

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

function runsEqual(a: Block, b: Block): boolean {
  if (a.runs.length !== b.runs.length) return false;
  return a.runs.every(
    (r, i) => r.text === b.runs[i]!.text && marksEqual(r.marks, b.runs[i]!.marks)
  );
}

export function diffModels(oldDoc: DocModel, newDoc: DocModel): BlockDiffEntry[] {
  const aIds = oldDoc.blocks.map((blk) => blk.id);
  const bIds = newDoc.blocks.map((blk) => blk.id);

  // LCS over block ids
  const n = aIds.length;
  const m = bIds.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        aIds[i] === bIds[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const entries: BlockDiffEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aIds[i] === bIds[j]) {
      const a = oldDoc.blocks[i]!;
      const b = newDoc.blocks[j]!;
      if (a.type === b.type && runsEqual(a, b)) {
        entries.push({ kind: "unchanged", a: i, b: j });
      } else {
        entries.push({
          kind: "changed",
          a: i,
          b: j,
          textChanged: blockText(a) !== blockText(b),
          formattingChanged: a.type !== b.type || !runsEqual(a, b),
        });
      }
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      entries.push({ kind: "removed", a: i });
      i++;
    } else {
      entries.push({ kind: "added", b: j });
      j++;
    }
  }
  while (i < n) entries.push({ kind: "removed", a: i++ });
  while (j < m) entries.push({ kind: "added", b: j++ });
  return entries;
}

export function diffSummary(entries: BlockDiffEntry[]): DiffSummary {
  const s: DiffSummary = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const e of entries) s[e.kind]++;
  return s;
}
