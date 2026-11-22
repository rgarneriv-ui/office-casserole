/**
 * Casserole document model — core types.
 * Canonical model per Architecture Specification §5.1 / §6.4 (v0 subset).
 * ADR-0002 records the scope of this subset and the path to the full model.
 */

export type Mark = "bold" | "italic" | "underline";

export type BlockType = "paragraph" | "heading1" | "heading2" | "bullet" | "numbered" | "table";

/** A contiguous span of text with a uniform mark set. */
export interface TextRun {
  text: string;
  marks: Mark[];
}

export interface Block {
  /** Stable identity for attribution/collaboration (ADR-0002). */
  id: string;
  type: BlockType;
  runs: TextRun[];
  /** Present exactly when type === "table": rows of plain-text cells
   *  (rectangular). Tables are atomic blocks (ADR-0011): edited through
   *  dedicated set-table operations, not the caret system. */
  table?: string[][];
}

export interface DocModel {
  schemaVersion: string;
  blocks: Block[];
}

/** Caret position: block index + character offset into the block's plain text. */
export interface Position {
  block: number;
  offset: number;
}

/** A possibly-backward selection; normalize with normRange() before use. */
export interface DocRange {
  anchor: Position;
  focus: Position;
}

export const SCHEMA_VERSION = "1.0";
