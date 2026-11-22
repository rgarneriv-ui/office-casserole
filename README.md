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
- **engines/format-conversion** — in-house ZIP container (CRC-validated,
  deflate via CompressionStream) and **DOCX export/import** for the model
  subset: lossless export, loss-reporting import (tables flattened with
  warnings, hyperlink text kept, corrupt packages rejected).
- **engines/spreadsheet-calc** — deterministic calculation engine (§7.2):
  tokenizer → parser → dependency graph → **incremental recalculation**
  (proven by eval-count tests), typed error values that propagate, cycle
  detection with recovery, 17-function registry.
- **apps/write** — Casserole Write slice: unified command dispatch (§18.2),
  toolbar + shortcuts, **durable multi-document storage** (IndexedDB with
  reported fallbacks) and a Files surface, Reveal Codes panel with
  click-to-select and "explain this formatting", Open .docx/.json, exports
  (DOCX/MD/HTML/JSON) with destructive-export confirmation.
- **engines/pdf-engine** — PDF 1.4 writer with exact Courier metrics
  (deterministic pagination, identical input → identical bytes), underline
  drawing, charset loss reporting; cross-validated with pypdf.
- **engines/presentation-model** — typed slide/element model (§8) with
  operations, clamping, validation, JSON round-trip; shares the generic undo
  `History`.
- **apps/sheets** — Casserole Sheets slice: grid over the calc engine,
  formula-bar editing, keyboard navigation, autosave, CSV export.
- **apps/slides** — Casserole Slides slice: thumbnails, canvas editing (drag,
  resize, double-click text edit), undo/redo, autosave, present mode, JSON
  export.
- **packages/shared-types** — §13.1 ResourceEnvelope, §15.4 agent execution
  contract, §18.2 command definition contract.
- **specs/** — ADR-0001..0005 and the machine-readable feature registry
  (schema + 8 records with statuses and evidence).

## Build & verify

```bash
npm install
npm run build     # engines + bundled Write, Sheets, and Slides apps
npm test          # unit suites (58 tests) + jsdom smoke tests of all three apps
```

Open `apps/{write,sheets,slides}/dist/index.html`
(`index.standalone.html` variants are fully self-contained) in a browser.

## Repository layout

Per spec §4.3, trimmed to directories that have real content; the remaining
§4.3 tree is created as its owning features land, not before.

```
engines/document-model/     canonical Write model, ops, history, inspector, serialize (+tests)
engines/format-conversion/  ZIP container + DOCX serializer/parser (+tests)
engines/spreadsheet-calc/   formula tokenizer/parser, dep graph, incremental recalc (+tests)
engines/pdf-engine/         PDF 1.4 writer, deterministic layout (+tests)
engines/presentation-model/ typed deck model + operations (+tests)
apps/write/                 Casserole Write application slice
apps/sheets/                Casserole Sheets application slice
apps/slides/                Casserole Slides application slice
packages/shared-types/      §13.1 / §15.4 / §18.2 platform contracts
specs/adr/                  architecture decision records
specs/features/             feature registry schema + records (statuses + evidence)
scripts/                    build + smoke-test scripts
```

## Feature status (registry extract)

| Feature | Status | Evidence |
| --- | --- | --- |
| WRITE-EDIT-001 core editing + undo | **tested** | unit suites, jsdom boot test |
| WRITE-FMT-001 Reveal Codes inspector | **tested** | inspector unit suite |
| WRITE-PERSIST-001 autosave + recovery | **implemented** | smoke assert; reload E2E pending |
| WRITE-PERSIST-002 multi-doc store + Files | **tested** | smoke scenarios incl. migration |
| WRITE-EXPORT-001 export + loss reports | **tested** | serialize unit suite |
| WRITE-CONV-001 DOCX export/import | **tested** | round-trip + loss-report suites |
| WRITE-CONV-002 PDF export | **tested** | xref/pagination suites + pypdf cross-validation |
| SHEETS-CALC-001 calculation engine | **tested** | 14-test suite incl. incrementality proof |
| SHEETS-GRID-001 grid app slice | **tested** | smoke: boot, recalc ripple, autosave |
| SLIDES-MODEL-001 presentation model | **tested** | deck operations + round-trip suite |
| SLIDES-EDIT-001 slides editor slice | **tested** | smoke: boot, add/undo, autosave, present |

Statuses follow §22.4 (`specified → implemented → tested → verified →
released`); nothing is marked *verified* because independent verification
(§24.2) has not run, and DOCX/formula work has no real-Word/Excel differential
corpus yet (§22.2).

## Phase position (spec §25)

All four Phase-3 core editors now exist as working, tested vertical slices
(Write, Sheets, Slides, PDF generation). The Phase-3 exit gate — "all four
editors complete **validated representative workflows**" — additionally
requires differential fixture corpora against real Office files, which do not
exist yet; the gate is therefore **not** claimed as passed.

## Next engineering tasks (dependency order)

1. Real-Word/Excel fixture corpus + differential testing (§22.2); Original
   Format Preservation store (§5.1) for round-tripping unknown parts.
2. XLSX import/export for Sheets and PPTX for Slides through the
   format-conversion pipeline (same loss-report contract).
3. Reveal Codes in-panel code editing (§6.2.3); inline rich text editing in
   Slides; proportional-font PDF output (ADR-0006 path).
4. Lift command sets into the `CommandDefinition` registry + command palette.
5. Collaboration/versioning layer (Phase 4) once the engines above stabilize.
