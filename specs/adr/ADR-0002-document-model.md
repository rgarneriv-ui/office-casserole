# ADR-0002: Canonical document model

**Status:** Accepted · 2026-11-22
**Context:** Spec §5.1 (typed, versioned, application-specific models), §6.4.

## Decision

- The Write model is `DocModel { schemaVersion, blocks[] }`; a `Block` has a
  stable `id` (future attribution/collaboration anchor), a `BlockType`, and
  `TextRun[]`; a `TextRun` is text + a uniform `Mark[]`.
- **Invariants** (enforced by `validateModel`, re-established by
  `normalizeModel` after every operation): no empty runs; adjacent runs with
  equal mark sets are merged; marks are canonically ordered; ≥1 block; unique
  block ids; schemaVersion matches.
- Positions are `{block, offset}` over the block's plain text; ranges may be
  backward and are normalized at the operation boundary.
- The Reveal Codes inspector (§6.2) is a **pure derivation** of this model,
  recomputed on read — explicitly not a second source of truth.

## Consequences

- Run splitting/merging arithmetic is centralized (`splitRunsAt`, `runsSlice`)
  and unit-tested, so operations stay small.
- v0 block types are paragraph/heading1/heading2; tables, lists, objects, and
  sections extend `Block` as new node kinds under the same invariant regime.
