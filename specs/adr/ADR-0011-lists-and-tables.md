# ADR-0011: Lists and atomic tables

**Status:** Accepted · 2026-11-22
**Context:** Spec §6.1 (tables, numbering among required Write capabilities).

## Decision

**Lists** are ordinary block types (`bullet`, `numbered`) and flow through the
whole pipeline unchanged: operations, op log, OT, diff, Reveal Codes, and all
serializers. Enter continues a list (engine rule); Enter on an empty item
exits it (UI rule). DOCX uses real OOXML numbering (numbering.xml +
ListParagraph + numPr) both ways; nested levels flatten to level 0 with a
warning on import.

**Tables are atomic blocks** in v0: a `table` block carries rectangular
plain-text cell data and no runs, and is edited exclusively through dedicated
`set-table` operations (cell edit, add/remove row/col, convert) — never
through the caret/position system. Rationale: the §6.1 full table model
(nested content, per-cell runs, spans, pagination) would force cell-paths
into Position and destabilize the proven op/OT layer; an atomic block
delivers working, invertible, journaled tables now, with conflicts on
concurrent table edits surfaced honestly (diverging conversions conflict;
identical ones dedupe).

Fidelity per format: HTML full grid; Markdown pipe tables (multi-line cells
flattened with warning); DOCX real `w:tbl` export and import (spans flattened
and cell formatting dropped with warnings); PDF rows as separated text with a
`PDF-TABLE-SIMPLIFIED` note.

## Consequences / next steps

- Rich cell content requires promoting cells to block containers — a
  recorded migration that replaces `set-table` data payloads with nested
  block ids; the atomic API (insert/edit/remove) survives that change.
- Table grid drawing in PDF, column widths/alignment, and cell spans are
  follow-up work orders; each lands as additional loss-report honesty first.
