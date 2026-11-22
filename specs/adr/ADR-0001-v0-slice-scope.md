# ADR-0001: Scope and deliberate deviations of the v0 vertical slice

**Status:** Accepted · 2026-11-22
**Context:** Architecture Specification v1.0 §25 Phase 0–2, §30 Initial Program.

## Decision

The first increment implements the §30 Initial Program as a working vertical
slice (repo + build, shared contracts, document model, Casserole Write editing
workflow, automated verification) with these recorded deviations from the
target architecture, each with a migration path:

| Area | Target (spec) | v0 slice | Migration path |
| --- | --- | --- | --- |
| Core engine language | Rust (§4.2) | TypeScript | Model/ops API is pure and side-effect-free per function; port behind the same typed interface once perf profiling justifies it (§4.2 requires a spike first anyway) |
| Local durable store | SQLite + encrypted blobs (§13.2) | `localStorage` journal in the browser slice | Storage is isolated behind `save()`/`restore()`; swap for IndexedDB, then SQLite (Tauri desktop shell) |
| Undo | Operation logs (§14.1) | ~~Transaction snapshots~~ **Migrated: ADR-0009 operation log** (document engine; Slides deck still snapshot-based) | Done for Write/document-model |
| Formats | DOCX/ODT/PDF (§5.2) | Native JSON (lossless), HTML (lossless for subset), Markdown (lossy **with loss report**) | Conversion pipeline stages per §5.2; the loss-report contract is already in place and DOCX plugs into it |
| Identity/permissions | Zero-trust platform (§17) | None (single local user) | `packages/shared-types` carries the §13.1/§15.4 contracts so later services compile against them from day one |

## Consequences

- No feature is claimed beyond what runs; the feature registry statuses
  (specs/features/) reflect this.
- The §1.2.1 "real functionality" rule is honored inside the slice: editing,
  persistence, recovery, undo, inspection, and export all function end to end.
