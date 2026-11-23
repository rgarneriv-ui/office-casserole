# ADR-0013: Office-style ribbon with honest placeholders

Date: 2026-11-23 · Status: accepted

## Context
The flat single-row toolbars diverged from the familiar Office surface the
suite is meant to compete with. The user asked for the Office ribbon with
the same buttons as the corresponding Microsoft product.

## Decision
A shared ribbon component (`apps/shared/ribbon.ts`) renders tab strip →
groups → controls, styled after the Office ribbon (layout, grouping,
command names, shortcuts, quick-access row). Three rules:

1. **Re-home, don't rebuild.** Existing wired controls are physically moved
   (`appendChild`) into their Office group, so listeners, element ids, and
   every prior smoke test survive unchanged.
2. **Honest placeholders.** Office commands Casserole does not implement
   render at their real ribbon position but disabled, with a
   "not yet implemented" tooltip (spec §22.4: no control fakes success).
   Density is representative — Office ships hundreds of commands; we show
   the recognizable core of each group.
3. **No Microsoft artwork.** Structure, grouping and naming mirror Office;
   icons are our own text glyphs. Copying Microsoft's icon set or trade
   dress is not an option.

## Consequences
- Word/Excel/PowerPoint users land in a familiar surface; what's greyed out
  doubles as a visible, honest feature roadmap.
- New features land by flipping a placeholder to a wired control in place.
- No contextual tabs (Table Design), ribbon collapse, or keytips yet; the
  Slides props bar remains the contextual formatting surface.
