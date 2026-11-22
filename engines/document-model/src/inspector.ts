/**
 * Structural Formatting Inspector — feature WRITE-FMT-001 (spec §6.2).
 * Produces an ordered stream of "codes" (WordPerfect Reveal Codes–style) that
 * is derived from the canonical model on every read. It is an inspector of the
 * model, never a second source of truth (§6.2 closing requirement).
 */

import { DocModel, Mark } from "./types";
import { blockText, marksEqual, sortMarks } from "./model";

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
};

const MARK_LABEL: Record<Mark, string> = {
  bold: "Bold",
  italic: "Italic",
  underline: "Underline",
};

/** Walk the model in document order and emit formatting codes. */
export function inspect(model: DocModel): FormatCode[] {
  const codes: FormatCode[] = [];
  model.blocks.forEach((block, bi) => {
    const len = blockText(block).length;
    codes.push({
      kind: "block-start",
      label: `[${BLOCK_LABEL[block.type] ?? block.type}]`,
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
