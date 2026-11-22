# ADR-0006: PDF generation engine

**Status:** Accepted · 2026-11-22
**Context:** Spec §9.1 (PDF runtime), §6.4 (deterministic pagination).

## Decision

- `engines/pdf-engine` writes PDF 1.4 directly (objects, content streams,
  xref, trailer) with no third-party dependency.
- **Courier only in v0** — every Courier glyph advances exactly 600/1000 em,
  so line breaking and pagination are computed from exact metrics. The §6.4
  deterministic-pagination requirement is therefore true, not approximated;
  identical input produces identical bytes (tested).
- WinAnsi/Latin-1 text; unsupported characters become `?` **and** a
  `PDF-CHARSET` loss warning — never silent mangling. Every export carries a
  loss report, including a standing `PDF-FONT-FAMILY` note so the fixed-pitch
  rendering is disclosed to the user.
- Content streams are uncompressed in v0 so output is inspectable and the
  tests can assert on text placement directly.

## Verification

Beyond the unit suite (xref offsets resolve to their objects, escaping,
pagination determinism, hard word-breaking), output is cross-validated with an
independent implementation: pypdf parses generated multi-page files and
extracts the text. That is tool-level independent evidence, not the §24.2
independent review, and the registry status stays at *tested*.

## Consequences / next steps

Proportional fonts need an embedded-font + metrics pipeline (AFM/TrueType),
which is the recorded path to Helvetica/serif output; PDF *reading*,
annotations, forms, signatures, and PDF/A (§9.1) are separate work orders.
