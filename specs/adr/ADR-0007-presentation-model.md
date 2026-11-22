# ADR-0007: Presentation model

**Status:** Accepted · 2026-11-22
**Context:** Spec §8 (presentation engine), §8.1 (scene graph), §8.2
(AI-generated content must be real editable elements).

## Decision

- `engines/presentation-model` defines a typed deck: slides of elements on a
  1600×900 logical canvas. v0 element kinds are `text` and `rect`; geometry is
  clamped to the canvas by every update, and `validateDeck` enforces the
  invariants (unique ids, known kinds, on-canvas geometry, ≥1 slide).
- Renderers (editor canvas, thumbnails, present stage) all scale the same
  logical coordinates — one source of truth, three views.
- The undo `History` from the document engine was genericized (`History<T>`)
  rather than duplicated, honoring §3.1 single-ownership.
- §8.2 is a hard rule here: anything that generates slides (AI included, when
  it arrives) must emit these elements. A rendered image of a slide is not an
  acceptable representation except as an explicit flattened export.

## Consequences / next steps

- Masters/layouts/themes, media elements, animations (time-based scheduling,
  §8.1), and PPTX import/export through the format-conversion pipeline are the
  recorded next work orders; PPTX joins the same loss-report contract.
- Present mode currently renders statically; animation scheduling will need
  the reproducible-timestamp design from §8.1 before it lands.
