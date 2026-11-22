# ADR-0003: Unified command dispatch and undo contract

**Status:** Accepted · 2026-11-22
**Context:** Spec §18.2 (one canonical command per capability), §14.2.

## Decision

- All editing — keyboard, toolbar, shortcuts, paste, and (later) AI proposals —
  routes through one `dispatch(commandId, payload)` in the application layer,
  which calls engine operations and owns history checkpoints. The
  contenteditable surface is a renderer and input source only: every
  `beforeinput` is prevented and re-expressed as a command.
- Undo is transaction-scoped: `History.checkpoint(model, coalesceKey)` before
  each transaction; consecutive `insertText`/`deleteBackward` with the same key
  inside a 1s window coalesce into one user-visible undo step (§14.2 "do not
  treat every keystroke as a version").
- Unsupported input types are ignored whole, never half-applied.

## Consequences

- An AI "proposed-change" flow (§15.6) later becomes: generate command lists,
  show the diff, dispatch on approval — no new editing pathway needed.
- The `CommandDefinition` contract in packages/shared-types is the target
  shape; v0 wires a closed command set directly and will lift it into the
  registry when the palette/permission layers arrive.
