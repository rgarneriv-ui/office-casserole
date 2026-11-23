# ADR-0012: Preserve-until-touched for foreign constructs inside document.xml

Date: 2026-11-23 · Status: accepted

## Context
WO-32 (ADR-0004 addendum) preserves foreign *package parts* (styles, themes,
settings) on DOCX round-trips. Constructs *inside* `document.xml` — fields
(`fldSimple`, `fldChar`/`instrText`), content controls (`sdt`), hyperlinks,
comment anchors — were still flattened to plain text with loss warnings.
Spec §5.1 requires original-format preservation with honest diagnostics.

## Decision
Blocks gain an opaque `foreignDocx?: { xml, hash }` payload:
- **Import** serializes the original `<w:p>` (or whole single-paragraph
  `<w:sdt>`) via an injectable `XmlSerialize`, extracts display text into
  runs, and stores a content hash computed *after* model normalization.
- **Export** re-emits the original XML verbatim while `contentHash(block)`
  still equals the stored hash; an edited block regenerates from the model
  and reports `DOCX-FOREIGN-DROPPED`. `exportDocx` is no longer
  unconditionally lossless — its report carries these warnings.
- Multi-paragraph `sdt` wrappers are unwrapped (content kept, wrapper
  dropped, `DOCX-IMPORT-SDT-UNWRAPPED` reported) rather than preserved,
  because one payload cannot ride on several independently editable blocks.

The payload is opaque to the engine: ops never touch it, merges and
conversions naturally invalidate the hash, and JSON persistence carries it
through autosave/journal replay unchanged.

## Consequences
- Open-in-Word fidelity for the common "open, tweak one paragraph, save"
  flow: untouched fields, controls and links survive byte-identical.
- Honest statuses: these constructs render as plain text in Casserole; the
  registry records preservation, not support.
- Serializer injection keeps jsdom test lanes working (`XMLSerializer` from
  the JSDOM window), mirroring the existing `XmlParse` pattern.

## Migration path
Per-run preservation (hyperlink splits inside an edited paragraph), relationship
re-wiring for preserved hyperlink rIds pointing at merged rels, and preserved
rendering (read-only field shading in the editor) can layer on without schema
changes.
