# Office Casserole

Modular, AI-native productivity suite. This repository implements the
**Architecture Specification v1.0** (2026-11-22) through working, verified
vertical slices — starting with the §30 Initial Program: platform scaffolding,
shared contracts, the canonical document engine, and the first functioning
**Casserole Write** editing workflow.

> Honest-status note (spec §1.2.1, §22.4): only what is listed in
> `specs/features/` with evidence exists. Nothing else in the 25-application
> target portfolio is implemented yet.

## What works today

- **engines/document-model** — typed, versioned document model with enforced
  invariants; editing operations (insert, delete across blocks, split/merge,
  marks, block types); transaction-coalesced undo/redo; **Reveal Codes**
  structural inspector (§6.2) derived from the canonical model; JSON/HTML
  serialization and Markdown export with a per-export **loss report** (§5.2).
- **apps/write** — Casserole Write slice: all input routed through unified
  command dispatch (§18.2), toolbar + shortcuts, autosave journal with crash
  recovery, Reveal Codes panel with click-to-select and "explain this
  formatting", export buttons with destructive-export confirmation.
- **packages/shared-types** — §13.1 ResourceEnvelope, §15.4 agent execution
  contract, §18.2 command definition contract.
- **specs/** — ADR-0001..0003 and the machine-readable feature registry
  (schema + records with statuses and evidence).

## Build & verify

```bash
npm install
npm test          # compiles engine + runs unit suites (27 tests)
npm run build     # engine + bundled Write app
node scripts/smoke-write.mjs   # jsdom boot test of the built app
```

Open `apps/write/dist/index.html` (or `index.standalone.html`, fully
self-contained) in a browser.

## Repository layout

Per spec §4.3, trimmed to directories that have real content; the remaining
§4.3 tree is created as its owning features land, not before.

```
engines/document-model/   canonical Write model, ops, history, inspector, serialize (+tests)
apps/write/               Casserole Write application slice
packages/shared-types/    §13.1 / §15.4 / §18.2 platform contracts
specs/adr/                architecture decision records
specs/features/           feature registry schema + records (statuses + evidence)
scripts/                  build + smoke-test scripts
```

## Feature status (registry extract)

| Feature | Status | Evidence |
| --- | --- | --- |
| WRITE-EDIT-001 core editing + undo | **tested** | 27/27 unit tests, jsdom boot test |
| WRITE-FMT-001 Reveal Codes inspector | **tested** | inspector unit suite |
| WRITE-PERSIST-001 autosave + recovery | **implemented** | smoke assert; reload E2E pending |
| WRITE-EXPORT-001 export + loss reports | **tested** | serialize unit suite |

Statuses follow §22.4 (`specified → implemented → tested → verified →
released`); nothing here is marked *verified* because independent verification
has not run yet.

## Next engineering tasks (dependency order, spec §25)

1. IndexedDB document store + multi-document Files surface (ADR-0001 migration).
2. Reveal Codes in-panel code editing (§6.2.3) and formatting repair.
3. DOCX import/export through the §5.2 conversion pipeline with fixtures.
4. Lift the command set into the `CommandDefinition` registry + command palette.
5. Spreadsheet calculation engine spike (tokenizer → AST → dependency graph).
