/**
 * Casserole spreadsheet calculation engine — core types (spec §7.2).
 * Deterministic evaluation model: typed values, explicit error values that
 * propagate, and a formula AST produced by the tokenizer/parser.
 */

export type ErrorCode = "#DIV/0!" | "#REF!" | "#NAME?" | "#VALUE!" | "#CYCLE!" | "#NUM!" | "#PARSE!";

export interface ErrorValue {
  kind: "error";
  code: ErrorCode;
  detail?: string;
}

export type CellScalar = number | string | boolean;
/** null = empty cell */
export type CellValue = CellScalar | ErrorValue | null;

export function isError(v: CellValue): v is ErrorValue {
  return typeof v === "object" && v !== null && v.kind === "error";
}

export function err(code: ErrorCode, detail?: string): ErrorValue {
  return { kind: "error", code, detail };
}

// ---------- addresses ----------
export interface Addr {
  col: number; // 0-based
  row: number; // 0-based
}

// ---------- AST ----------
export type Ast =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "ref"; addr: Addr }
  | { t: "range"; from: Addr; to: Addr }
  | { t: "bin"; op: string; l: Ast; r: Ast }
  | { t: "un"; op: "-" | "+"; v: Ast }
  | { t: "call"; name: string; args: Ast[] };
