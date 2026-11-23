/**
 * Structural Formatting Inspector — feature WRITE-FMT-001 (spec §6.2).
 * Produces an ordered stream of "codes" (WordPerfect Reveal Codes–style) that
 * is derived from the canonical model on every read. It is an inspector of the
 * model, never a second source of truth (§6.2 closing requirement).
 */

import { BlockType, DocModel, Mark } from "./types";
import { blockText, marksEqual, sortMarks } from "./model";
import { setBlockType, toggleMark } from "./operations";
import { OpRecorder } from "./oplog";

export type CodeKind = "block-start" | "block-end" | "mark-on" | "mark-off" | "text";

export interface FormatCode {
  kind: CodeKind;
  label: string;
  /** Block the code belongs to. */
  blockIndex: number;
  /** Character range in the block's plain text that this code affects. */
  start: number;
  end: number;
}

const BLOCK_LABEL: Record<string, string> = {
  paragraph: "Para",
  heading1: "Heading 1",
  heading2: "Heading 2",
  bullet: "Bullet",
  numbered: "Numbered",
};

const MARK_LABEL: Record<Mark, string> = {
  bold: "Bold",
  italic: "Italic",
  underline: "Underline",
  strike: "Strikethrough",
};

/** Walk the model in document order and emit formatting codes. */
export function inspect(model: DocModel): FormatCode[] {
  const codes: FormatCode[] = [];
  model.blocks.forEach((block, bi) => {
    const len = blockText(block).length;
    const label =
      block.type === "table" && block.table
        ? `[Table ${block.table.length}\u00d7${block.table[0]!.length}]`
        : `[${BLOCK_LABEL[block.type] ?? block.type}]`;
    codes.push({
      kind: "block-start",
      label,
      blockIndex: bi,
      start: 0,
      end: len,
    });
    let offset = 0;
    let active: Mark[] = [];
    for (const run of block.runs) {
      const next = sortMarks(run.marks);
      if (!marksEqual(active, next)) {
        // close marks no longer active (in reverse order), open new ones
        for (const m of [...active].reverse()) {
          if (!next.includes(m)) {
            codes.push({
              kind: "mark-off",
              label: `[${MARK_LABEL[m]} Off]`,
              blockIndex: bi,
              start: offset,
              end: offset,
            });
          }
        }
        for (const m of next) {
          if (!active.includes(m)) {
            codes.push({
              kind: "mark-on",
              label: `[${MARK_LABEL[m]} On]`,
              blockIndex: bi,
              start: offset,
              end: offset + run.text.length,
            });
          }
        }
        active = next;
      }
      codes.push({
        kind: "text",
        label: run.text,
        blockIndex: bi,
        start: offset,
        end: offset + run.text.length,
      });
      offset += run.text.length;
    }
    for (const m of [...active].reverse()) {
      codes.push({
        kind: "mark-off",
        label: `[${MARK_LABEL[m]} Off]`,
        blockIndex: bi,
        start: offset,
        end: offset,
      });
    }
    codes.push({
      kind: "block-end",
      label: "[End]",
      blockIndex: bi,
      start: len,
      end: len,
    });
  });
  return codes;
}

/**
 * §6.2.3 — edit or remove supported formatting instructions through a
 * controlled interface. Code actions are translated into ordinary model
 * operations against the canonical model; the codes panel never becomes a
 * second source of truth. Returns a human-readable description of what was
 * done, or null when the code supports no such action.
 */
export type CodeAction =
  | { kind: "remove-mark" }
  | { kind: "set-block-type"; blockType: BlockType };

export function codeActionsFor(code: FormatCode): string[] {
  if (code.kind === "mark-on" || code.kind === "mark-off") return ["remove-mark"];
  if (code.kind === "block-start") return ["set-block-type"];
  return [];
}

/** The mark a mark-on/off code refers to, derived from its label. */
function markOfCode(code: FormatCode): Mark | null {
  for (const [mark, label] of Object.entries(MARK_LABEL) as [Mark, string][]) {
    if (code.label.startsWith(`[${label} `)) return mark;
  }
  return null;
}

/**
 * Find the full extent of the mark span that a mark-on/off code belongs to:
 * the maximal run of characters around the code position carrying the mark.
 */
export function markSpanOf(
  model: DocModel,
  code: FormatCode
): { mark: Mark; start: number; end: number } | null {
  const mark = markOfCode(code);
  if (mark === null) return null;
  const block = model.blocks[code.blockIndex];
  if (!block) return null;
  // Build a per-character mark table for the block.
  const flags: boolean[] = [];
  for (const run of block.runs) {
    const has = run.marks.includes(mark);
    for (let i = 0; i < run.text.length; i++) flags.push(has);
  }
  // The span adjoins the code position: for mark-on the span starts at
  // code.start; for mark-off it ends at code.start.
  let pos = code.kind === "mark-on" ? code.start : code.start - 1;
  if (pos < 0 || pos >= flags.length || !flags[pos]) return null;
  let start = pos;
  while (start > 0 && flags[start - 1]) start--;
  let end = pos + 1;
  while (end < flags.length && flags[end]) end++;
  return { mark, start, end };
}

export function applyCodeAction(
  model: DocModel,
  code: FormatCode,
  action: CodeAction,
  rec?: OpRecorder
): string | null {
  if (action.kind === "remove-mark" && (code.kind === "mark-on" || code.kind === "mark-off")) {
    const span = markSpanOf(model, code);
    if (!span) return null;
    const range = {
      anchor: { block: code.blockIndex, offset: span.start },
      focus: { block: code.blockIndex, offset: span.end },
    };
    toggleMark(model, range, span.mark, rec);
    return `Removed ${MARK_LABEL[span.mark]} from characters ${span.start}–${span.end} of block ${code.blockIndex + 1}`;
  }
  if (action.kind === "set-block-type" && code.kind === "block-start") {
    const block = model.blocks[code.blockIndex];
    if (!block) return null;
    setBlockType(
      model,
      {
        anchor: { block: code.blockIndex, offset: 0 },
        focus: { block: code.blockIndex, offset: 0 },
      },
      action.blockType,
      rec
    );
    return `Block ${code.blockIndex + 1} set to ${BLOCK_LABEL[action.blockType]}`;
  }
  return null;
}

/** §6.2.4 — explain why formatting changes at a position. */
export function explainAt(model: DocModel, blockIndex: number, offset: number): string {
  const block = model.blocks[blockIndex];
  if (!block) return "Position is outside the document.";
  let consumed = 0;
  for (const run of block.runs) {
    const end = consumed + run.text.length;
    if (offset >= consumed && offset <= end) {
      const marks = sortMarks(run.marks);
      const markText = marks.length
        ? marks.map((m) => MARK_LABEL[m]).join(" + ")
        : "no character formatting";
      return (
        `Block ${blockIndex + 1} is a ${BLOCK_LABEL[block.type] ?? block.type}. ` +
        `Characters ${consumed}–${end} carry ${markText}. ` +
        (consumed === offset && consumed > 0
          ? "Formatting changes here because the previous run ends at this position."
          : "This position is inside a single uniform run.")
      );
    }
    consumed = end;
  }
  return `Block ${blockIndex + 1} (${BLOCK_LABEL[block.type] ?? block.type}) is empty at this position.`;
}
