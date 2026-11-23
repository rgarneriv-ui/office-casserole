/**
 * Casserole document model — core types.
 * Canonical model per Architecture Specification §5.1 / §6.4 (v0 subset).
 * ADR-0002 records the scope of this subset and the path to the full model.
 */

export type Mark = "bold" | "italic" | "underline" | "strike";

export type BlockType = "paragraph" | "heading1" | "heading2" | "bullet" | "numbered" | "table";

/** A contiguous span of text with a uniform mark set. */
export interface TextRun {
  text: string;
  marks: Mark[];
}

export type ColAlign = "left" | "center" | "right" | null;

export interface TableStyle {
  headerRow?: boolean;
  /** one entry per column; null = default */
  aligns?: ColAlign[];
  /** relative column widths, one per column (normalized by renderers) */
  widths?: number[];
}

export interface Block {
  /** Stable identity for attribution/collaboration (ADR-0002). */
  id: string;
  type: BlockType;
  runs: TextRun[];
  /** List nesting level 0–3; only meaningful on bullet/numbered blocks. */
  indent?: number;
  /** Present exactly when type === "table": rows of plain-text cells
   *  (rectangular). Tables are atomic blocks (ADR-0011): edited through
   *  dedicated set-table operations, not the caret system. */
  table?: string[][];
  /** Table presentation (only with table): header row, per-column alignment
   *  and relative widths. Travels inside set-table payloads. */
  tableStyle?: TableStyle;
  /** §5.1 preserve-until-touched: the original source XML of a paragraph
   *  containing constructs we cannot model (fields, content controls, comment
   *  anchors, hyperlinks), plus a hash of the imported content. Exporters
   *  re-emit the original XML while the hash still matches; an edited block
   *  regenerates and reports the dropped constructs. Opaque to the engine. */
  foreignDocx?: { xml: string; hash: string };
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
