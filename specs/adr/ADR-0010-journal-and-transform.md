# ADR-0010: Operation journal and transform/rebase semantics

**Status:** Accepted · 2026-11-22
**Context:** Spec §14.1 (operation ordering, causality, conflict detection,
author attribution), §13.2 (durable operation log and snapshots). Builds on
ADR-0009's primitive op set.

## Decision

- **DocumentJournal**: base snapshot + ordered, attributed transactions
  (txnId, actorId, seq, timestamp, primitive ops). Replay is deterministic
  and validated; serialization round-trips with full schema validation per
  op kind; compaction folds a prefix into the snapshot without changing
  replay. This is the wire/storage format for sync.
- **transformOp(b, a, bias)**: operational transformation over the primitive
  set with explicit, documented tie-breaks — same-point concurrent inserts
  are ordered by `bias` (callers derive it from a stable actor order);
  replacements straddling a concurrent split are partitioned; a split point
  inside a concurrent pure deletion collapses to the deletion start; a merge
  of a concurrently-split block composes unchanged.
- **Conflicts are surfaced, never silently merged**: overlapping
  replacements, same-point concurrent splits, double merges, diverging
  retypes, retype-of-merged-away, and anything against `replace-model` are
  explicit conflicts with reasons.
- **rebaseSequence** is transaction-granular (classic transform-cursor loop):
  a transaction rebases whole or is rejected whole, so a replica never holds
  half a transaction — the §14.1 commit semantics.

## Verification

TP1 convergence — `apply(S, a, b′) ≡ apply(S, b, a′)`, byte-equal snapshots,
block ids included — is proven by a test matrix across every supported
primitive pair, plus a sequence-level rebase convergence test and a
**two-replica simulation**: both replicas record real editing operations
against a shared origin, exchange and rebase, and converge exactly.

## Consequences / limits

- TP2 (transform against transformed ops across three+ concurrent sites) is
  NOT claimed; the current target is client/relay topology where a server
  totally orders transactions and clients rebase against the ordered stream.
- Next steps: relay protocol (cursor exchange per §14.3), conflict
  presentation UX, authorship surfacing in Write, and revisions as journal
  checkpoints.
