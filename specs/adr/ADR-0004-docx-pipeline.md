# ADR-0004: DOCX conversion pipeline and ZIP container

**Status:** Accepted · 2026-11-22
**Context:** Spec §5.2 (format compatibility, loss reports), §5.3.

## Decision

- OOXML packaging is implemented in-house (`engines/format-conversion`): a
  minimal ZIP writer/reader (CRC-32 validated; deflate through the platform
  `CompressionStream`/`DecompressionStream`, STORED fallback; no ZIP64 or
  encryption — out-of-scope inputs throw) plus a WordprocessingML
  serializer/parser for the Write model subset. No third-party zip/docx
  dependency, which keeps §27.4 license review trivial for this component.
- **Export** covers the full v0 model and is lossless for it.
- **Import** maps paragraphs, Heading1/2 (+Title), b/i/u, and keeps content it
  cannot model (tables flattened to paragraphs, hyperlink text kept) while
  recording a `DOCX-IMPORT-*` warning per loss. Per §5.2, the pipeline never
  claims fidelity it does not have: every conversion returns a LossReport.
- XML parsing is injectable (`parseXml`) so the engine runs under Node tests
  (jsdom DOMParser) and in the browser (native DOMParser) identically.

## Consequences

- Corrupt packages fail loudly (CRC/signature checks), never half-import.
- The §5.1 "Original Format Preservation" store (round-tripping unknown parts)
  is not yet implemented; imports are one-way into the native model and the
  registry says so. That store is the next step for this component, before
  tracked changes and comments.
- Fixture corpus currently consists of self-generated packages and synthetic
  Word-style markup; a corpus of real Word-produced files is required before
  any status above *tested* (§22.2 differential testing).
