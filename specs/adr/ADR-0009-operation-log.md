# ADR-0009: Operation-log undo

**Status:** Accepted · 2026-11-22
**Context:** Spec §14.1–14.2; completes the undo migrations recorded in
ADR-0001 and ADR-0003.

## Decision

- Every document mutation is expressed as one of five **invertible
  primitives** (`oplog.ts`): `replace-runs` (covers insert, delete, and mark
  changes within a block), `split-block`, `merge-blocks`, `set-block-type`,
  and `replace-model` (wholesale swaps: revision restore, import).
  `invertOp` is a pure involution; primitives carry the ids and content they
  create or remove, so undo→redo round-trips are byte-stable, ids included.
- High-level operations (`operations.ts`) decompose into primitives and
  mutate only through `applyOp` — **one mutation path** for live editing,
  undo/redo, Reveal Codes actions, and (later) remote operations. A
  cross-block delete decomposes as trim-tail / empty-middles / trim-head /
  merge-left, each step invertible.
- `TransactionLog` groups primitives into transactions with typing
  coalescing, replays inverses in reverse order for undo, and never coalesces
  across a redo boundary. Casserole Write now runs on it; the snapshot
  `History` remains only for the Slides deck (its migration is a follow-up).
- Property tests prove: single-op inversion for every editing operation, a
  7-step mixed session unwinding and replaying through exact intermediate
  states, and recorder/model aliasing isolation.

## Consequences

- The §14.1 collaboration requirements (operation ordering, causality,
  commit-time authorization) now have their substrate: a serializable,
  invertible operation stream. Next steps: op serialization format,
  per-transaction authorship, and transform/rebase semantics.
- Revisions (ADR-0008) still store full copies; converting them to log
  checkpoints is now mechanical.
- Memory: a transaction holds only its primitives (typically bytes per
  keystroke), replacing full-model snapshots per transaction.
