/**
 * Operational transformation over the primitive op set (spec §14.1:
 * concurrency semantics, operation ordering, conflict detection).
 *
 * transformOp(b, a, bias) rewrites op `b` (made against state S) so it can
 * apply after op `a` (also made against S). Tie-breaks are explicit and
 * deterministic:
 *   - Same-point concurrent inserts: bias "right" places b after a's
 *     insertion; the opposite side transforms with bias "left". Callers
 *     derive bias from a stable total order (actor id) so replicas agree.
 *   - A replace that straddles a concurrent split is partitioned into two
 *     replaces, one per resulting block.
 * Anything without a convergent rewrite is a CONFLICT, surfaced to the
 * caller — never silently merged. Conflicts are transaction-granular in
 * rebaseSequence: a transaction either rebases whole or is rejected whole,
 * so a replica never holds half a transaction (§14.1 commit semantics).
 *
 * Convergence (TP1: apply(S, a, b′) ≡ apply(S, b, a′)) is proven by the test
 * matrix in transform.test.ts for every supported pair, not asserted here.
 */

import { TextRun } from "./types";
import { splitRunsAt } from "./model";
import { PrimOp } from "./oplog";

export type Bias = "left" | "right";

export interface TransformResult {
  /** 0, 1, or 2 ops replacing b (0 = b became a no-op) */
  ops: PrimOp[];
  conflict: boolean;
  reason?: string;
}

function ok(...ops: PrimOp[]): TransformResult {
  return { ops, conflict: false };
}

function conflict(reason: string): TransformResult {
  return { ops: [], conflict: true, reason };
}

function runsLen(runs: TextRun[]): number {
  return runs.reduce((n, r) => n + r.text.length, 0);
}

export function transformOp(b: PrimOp, a: PrimOp, bias: Bias): TransformResult {
  if (b.t === "replace-model" || a.t === "replace-model") {
    return conflict("replace-model cannot be rebased against concurrent edits");
  }

  switch (b.t) {
    case "replace-runs":
      return transformRR(b, a, bias);
    case "split-block":
      return transformSP(b, a);
    case "merge-blocks":
      return transformMG(b, a);
    case "set-block-type":
      return transformST(b, a);
    case "set-table":
      return transformTB(b, a);
  }
}

type RR = Extract<PrimOp, { t: "replace-runs" }>;
type SP = Extract<PrimOp, { t: "split-block" }>;
type MG = Extract<PrimOp, { t: "merge-blocks" }>;
type ST = Extract<PrimOp, { t: "set-block-type" }>;
type TB = Extract<PrimOp, { t: "set-table" }>;

function transformTB(b: TB, a: Exclude<PrimOp, { t: "replace-model" }>): TransformResult {
  switch (a.t) {
    case "replace-runs":
      if (a.block === b.block) return conflict(`block ${b.block} was edited and concurrently converted to/from a table`);
      return ok(b);
    case "split-block":
      if (a.block === b.block) return conflict(`block ${b.block} was split and concurrently converted to/from a table`);
      if (b.block > a.block) return ok({ ...b, block: b.block + 1 });
      return ok(b);
    case "merge-blocks":
      if (a.block === b.block || a.block === b.block + 1)
        return conflict(`block ${b.block} was merged and concurrently converted to/from a table`);
      if (b.block > a.block) return ok({ ...b, block: b.block - 1 });
      return ok(b);
    case "set-block-type":
      if (a.block === b.block) return conflict(`block ${b.block} was retyped and concurrently table-converted`);
      return ok(b);
    case "set-table":
      if (a.block === b.block) {
        return JSON.stringify(a) === JSON.stringify(b)
          ? ok(b)
          : conflict(`block ${b.block} received diverging table conversions`);
      }
      return ok(b);
  }
}

function transformRR(b: RR, a: Exclude<PrimOp, { t: "replace-model" }>, bias: Bias): TransformResult {
  switch (a.t) {
    case "replace-runs": {
      if (a.block !== b.block) return ok(b);
      const delta = runsLen(a.after) - (a.to - a.from);
      const bothInserts = b.from === b.to && a.from === a.to;
      if (bothInserts && b.from === a.from) {
        return bias === "right"
          ? ok({ ...b, from: b.from + delta, to: b.to + delta })
          : ok(b);
      }
      if (b.to <= a.from) return ok(b); // b entirely before a
      if (b.from >= a.to) return ok({ ...b, from: b.from + delta, to: b.to + delta });
      return conflict(
        `overlapping edits in block ${b.block}: [${b.from},${b.to}) vs [${a.from},${a.to})`
      );
    }
    case "split-block": {
      if (b.block > a.block) return ok({ ...b, block: b.block + 1 });
      if (b.block < a.block) return ok(b);
      // same block as the split
      if (b.to <= a.offset) return ok(b); // entirely in the first half (same-point insert stays left)
      if (b.from >= a.offset) {
        return ok({ ...b, block: b.block + 1, from: b.from - a.offset, to: b.to - a.offset });
      }
      // straddles the split point: partition into two replaces
      if (runsLen(b.after) > 0) {
        return conflict(
          `replacement straddles a concurrent split in block ${b.block} (cannot partition the inserted content)`
        );
      }
      const [beforeLeft, beforeRight] = splitRunsAt(b.before, a.offset - b.from);
      return ok(
        { t: "replace-runs", block: b.block, from: b.from, to: a.offset, before: beforeLeft, after: [] },
        {
          t: "replace-runs",
          block: b.block + 1,
          from: 0,
          to: b.to - a.offset,
          before: beforeRight,
          after: [],
        }
      );
    }
    case "merge-blocks": {
      if (b.block > a.block) return ok({ ...b, block: b.block - 1 });
      if (b.block < a.block) return ok(b);
      // b edits the block that was merged away: retarget into the combined block
      return ok({ ...b, block: a.block - 1, from: b.from + a.seam, to: b.to + a.seam });
    }
    case "set-block-type":
      return ok(b);
    case "set-table":
      if (a.block === b.block) return conflict(`block ${b.block} was concurrently converted to/from a table`);
      return ok(b);
  }
}

function transformSP(b: SP, a: Exclude<PrimOp, { t: "replace-model" }>): TransformResult {
  switch (a.t) {
    case "replace-runs": {
      if (a.block !== b.block) return ok(b);
      const delta = runsLen(a.after) - (a.to - a.from);
      if (b.offset <= a.from) return ok(b);
      if (b.offset >= a.to) return ok({ ...b, offset: b.offset + delta });
      // split point inside the replaced range: for a pure deletion it
      // collapses to the deletion start (converges with the partition rule on
      // the other side); with inserted content there is no convergent spot
      if (runsLen(a.after) === 0) return ok({ ...b, offset: a.from });
      return conflict(`split point sits inside a concurrently replaced range in block ${b.block}`);
    }
    case "split-block": {
      if (b.block > a.block) return ok({ ...b, block: b.block + 1 });
      if (b.block < a.block) return ok(b);
      if (b.offset === a.offset) {
        return conflict(`both sides split block ${b.block} at the same point`);
      }
      if (b.offset > a.offset) {
        return ok({ ...b, block: b.block + 1, offset: b.offset - a.offset });
      }
      return ok(b);
    }
    case "merge-blocks": {
      if (b.block > a.block) return ok({ ...b, block: b.block - 1 });
      if (b.block < a.block) return ok(b);
      // splitting the block that was merged away: split the combined block
      return ok({ ...b, block: a.block - 1, offset: b.offset + a.seam });
    }
    case "set-block-type":
      return ok(b);
    case "set-table":
      if (a.block === b.block) return conflict(`block ${b.block} was concurrently converted to/from a table`);
      return ok(b);
  }
}

function transformMG(b: MG, a: Exclude<PrimOp, { t: "replace-model" }>): TransformResult {
  switch (a.t) {
    case "replace-runs": {
      if (a.block === b.block - 1) {
        // predecessor content changed: the seam moves by a's length delta
        const delta = runsLen(a.after) - (a.to - a.from);
        return ok({ ...b, seam: b.seam + delta });
      }
      return ok(b);
    }
    case "split-block": {
      if (a.block === b.block) {
        // The merged block was split: merging its first half into the
        // predecessor (seam unchanged) converges with the retargeted split
        // on the other side — proven by the TP1 matrix.
        return ok(b);
      }
      if (a.block === b.block - 1) {
        // predecessor split: merge into its second half
        return ok({ ...b, block: b.block + 1, seam: b.seam - a.offset });
      }
      if (a.block < b.block - 1) return ok({ ...b, block: b.block + 1 });
      return ok(b);
    }
    case "merge-blocks": {
      if (a.block === b.block) {
        return conflict(`both sides merged block ${b.block} concurrently`);
      }
      if (a.block === b.block - 1) {
        // b's predecessor was merged into its own predecessor
        return ok({ ...b, block: b.block - 1, seam: b.seam + a.seam });
      }
      if (a.block < b.block - 1) return ok({ ...b, block: b.block - 1 });
      return ok(b);
    }
    case "set-block-type":
      return ok(b);
    case "set-table":
      if (a.block === b.block || a.block === b.block - 1)
        return conflict(`merge touches block ${a.block}, concurrently converted to/from a table`);
      return ok(b);
  }
}

function transformST(b: ST, a: Exclude<PrimOp, { t: "replace-model" }>): TransformResult {
  switch (a.t) {
    case "replace-runs":
      return ok(b);
    case "split-block": {
      if (b.block > a.block) return ok({ ...b, block: b.block + 1 });
      return ok(b); // retyping the split block retypes its first half
    }
    case "merge-blocks": {
      if (b.block === a.block) {
        // retyping a block that was merged away cannot converge (merge keeps
        // the predecessor's type in the other order)
        return conflict(`block ${b.block} was retyped and concurrently merged away`);
      }
      if (b.block > a.block) return ok({ ...b, block: b.block - 1 });
      return ok(b);
    }
    case "set-block-type": {
      if (a.block === b.block && a.after !== b.after) {
        return conflict(`block ${b.block} concurrently retyped to different types`);
      }
      return ok(b);
    }
    case "set-table":
      if (a.block === b.block) return conflict(`block ${b.block} was concurrently converted to/from a table`);
      return ok(b);
  }
}

// ---------- sequence rebase ----------

export interface RebaseResult {
  ops: PrimOp[];
  conflict: boolean;
  reason?: string;
}

function opposite(bias: Bias): Bias {
  return bias === "left" ? "right" : "left";
}

/**
 * Rebase the op sequence `bOps` (one transaction, made against S) over the
 * concurrent sequence `aOps` (also made against S), with the classic
 * transform-cursor loop: each b is transformed through the (progressively
 * transformed) a sequence, and the a sequence is transformed over each b for
 * the benefit of the next b. Transaction-granular: any conflict rejects the
 * whole transaction.
 */
export function rebaseSequence(bOps: PrimOp[], aOps: PrimOp[], bias: Bias): RebaseResult {
  let aCur: PrimOp[] = [...aOps];
  const out: PrimOp[] = [];
  for (const bOrig of bOps) {
    let bParts: PrimOp[] = [bOrig];
    const aNext: PrimOp[] = [];
    for (const a of aCur) {
      // transform every current part of b over a
      let aParts: PrimOp[] = [a];
      const newBParts: PrimOp[] = [];
      for (const bPart of bParts) {
        // b over a (possibly already-transformed pieces of a)
        let pieces: PrimOp[] = [bPart];
        for (const aPart of aParts) {
          const next: PrimOp[] = [];
          for (const piece of pieces) {
            const r = transformOp(piece, aPart, bias);
            if (r.conflict) return { ops: [], conflict: true, reason: r.reason };
            next.push(...r.ops);
          }
          pieces = next;
        }
        // a over this original b part, for subsequent b ops
        const nextAParts: PrimOp[] = [];
        for (const aPart of aParts) {
          const r = transformOp(aPart, bPart, opposite(bias));
          if (r.conflict) return { ops: [], conflict: true, reason: r.reason };
          nextAParts.push(...r.ops);
        }
        aParts = nextAParts;
        newBParts.push(...pieces);
      }
      bParts = newBParts;
      aNext.push(...aParts);
    }
    aCur = aNext;
    out.push(...bParts);
  }
  return { ops: out, conflict: false };
}
