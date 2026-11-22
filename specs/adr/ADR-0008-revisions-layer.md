# ADR-0008: Document revisions layer

**Status:** Accepted · 2026-11-22
**Context:** Spec §14.2 (three-layer version model), §6.2.6.

## Decision

- The §14.2 middle layer lands first: **named document revisions** — stable,
  restorable content states stored with the document (StoredRevision in the
  Write store), explicitly distinct from the fine-grained operation history
  (bottom layer, still snapshot-based per ADR-0003) and from review branches
  (top layer, not yet built).
- Comparison is a pure engine function (`engines/document-model/diff.ts`):
  LCS over stable block ids, then content comparison that distinguishes
  **text changes from formatting-only changes** — the §6.3 comparison
  requirement applied at block granularity. Ids survive editing, so a split
  shows as changed+added rather than a remove/add cascade (tested).
- Restore goes through the normal history checkpoint, so a restore is itself
  undoable; unreadable revisions fail safe and are left untouched.

## Consequences / next steps

- Review branches and semantic merge (§14.2 top layer) build on diffModels.
- Run-level (intra-block) diff and the §6.3 moved-clause/renumbering
  detection are recorded follow-ups; block granularity is the honest current
  limit and the UI labels it as such.
- When operation logs replace snapshot undo (ADR-0003 migration), revisions
  become checkpoint references into the log instead of full copies.
