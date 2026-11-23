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
  invariants; editing operations that decompose into **invertible primitive
  operations** recorded in a transaction log (ADR-0009 — undo/redo replays
  inverses, byte-stable round-trips); **Reveal Codes** structural inspector
  (§6.2) derived from the canonical model; block-level diff; JSON/HTML
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

All four Phase-3 core editors exist as working, tested vertical slices (Write,
Sheets, Slides, PDF generation), each with Office-format conversion (DOCX,
XLSX, PPTX) through the loss-report pipeline and independent-parser
cross-validation (pypdf, openpyxl, python-pptx). The Phase-3 exit gate —
"validated representative workflows" — still requires a corpus of files
produced by real Word/Excel/PowerPoint, so the gate is **not** claimed as
passed.

## Compatibility fixtures (§22.2)

Drop real Office files into `tests/fixtures/docx/` and `tests/fixtures/xlsx/`
and run `node scripts/compat-fixtures.mjs`. The harness fails on crashes and
invalid models, records loss reports to `tests/fixtures/reports/` (diffable in
git), and for XLSX compares our recomputed formula values against the
producer's cached values. Seeded with python-docx and openpyxl fixtures;
files saved by actual Office applications are the ones that matter most.

## Next engineering tasks (dependency order)

1. Grow the fixture corpus with real Word/Excel/PowerPoint files. OFP now
   carries unknown DOCX package parts through edit round-trips, and
   constructs inside document.xml (fields, content controls, hyperlinks,
   comment anchors) are preserved until their paragraph is edited
   (ADR-0012); remaining §5.1 work is per-run preservation and preserved
   construct rendering in the editor.
2. Relay protocol (§14.3 cursor exchange), presence, and conflict UX —
   the first work that needs a second machine. Write already records into
   an attributed DocumentJournal at runtime (undo/redo journal as inverse
   transactions; replay-verified on open), and the OT layer has TP1
   convergence proofs plus a two-replica simulation (ADR-0009/0010).
   Remaining: revisions as log checkpoints (ADR-0008).
3. Intra-block (run-level) diff; review branches and semantic merge (§14.2
   top layer); migrate Slides deck undo to the op-log pattern.
4. Rich table cells (ADR-0011 migration), spans, PDF table grids; nested
   list levels.
5. Full command-registry inversion; palettes for Sheets/Slides; font
   embedding/subsetting for non-Latin PDF output.
