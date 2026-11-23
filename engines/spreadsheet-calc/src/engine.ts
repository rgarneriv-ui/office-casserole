/**
 * Sheet engine: dependency graph, cycle detection, incremental dirty-range
 * recalculation (spec §7.2). Deterministic: a given set of inputs always
 * yields the same values, and evaluation counts are observable so tests can
 * prove recalculation is incremental rather than whole-sheet.
 */

import { addrKey, formatAddr, parseAddr, rangeAddrs } from "./addr";
import { FUNCTIONS, toNumber, toText } from "./functions";
import { FormulaError, parseFormula } from "./parse";
import { Addr, Ast, CellValue, err, isError } from "./types";

export type NumFmt = "general" | "number2" | "currency" | "percent";

export interface CellFormat {
  bold?: boolean;
  align?: "left" | "center" | "right";
  numFmt?: NumFmt;
}

interface Cell {
  input: string;
  formula: Ast | null;
  value: CellValue;
  format?: CellFormat;
  /** keys of cells this cell reads */
  deps: Set<string>;
  /** keys of cells that read this cell */
  dependents: Set<string>;
}

function formatNumber(v: number, fmt: NumFmt): string {
  const grouped = (n: number, dec: number) =>
    n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  switch (fmt) {
    case "number2":
      return grouped(v, 2);
    case "currency":
      return v < 0 ? `-$${grouped(-v, 2)}` : `$${grouped(v, 2)}`;
    case "percent":
      return `${grouped(v * 100, 2)}%`;
    default:
      return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e10) / 1e10);
  }
}

function collectRefs(ast: Ast, out: Set<string>): void {
  switch (ast.t) {
    case "ref":
      out.add(addrKey(ast.addr));
      break;
    case "range":
      for (const a of rangeAddrs(ast.from, ast.to)) out.add(addrKey(a));
      break;
    case "bin":
      collectRefs(ast.l, out);
      collectRefs(ast.r, out);
      break;
    case "un":
      collectRefs(ast.v, out);
      break;
    case "call":
      for (const arg of ast.args) collectRefs(arg, out);
      break;
    default:
      break;
  }
}

function parseLiteral(input: string): CellValue {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const upper = trimmed.toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?%$/.test(trimmed)) {
    return Number(trimmed.slice(0, -1)) / 100;
  }
  const n = Number(trimmed);
  if (!Number.isNaN(n) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    return n;
  }
  return input;
}

export class Sheet {
  private cells = new Map<string, Cell>();
  /** column widths in Excel character units (default ≈ 8.43) */
  private colWidths = new Map<number, number>();
  /** row heights in points (default ≈ 15) */
  private rowHeights = new Map<number, number>();
  /** total formula evaluations — exposed so tests can prove incrementality */
  public evalCount = 0;

  getColWidth(col: number): number | undefined {
    return this.colWidths.get(col);
  }

  setColWidth(col: number, width: number | null): void {
    if (width === null || width <= 0) this.colWidths.delete(col);
    else this.colWidths.set(col, Math.min(120, Math.round(width * 100) / 100));
  }

  cols(): { col: number; width: number }[] {
    return [...this.colWidths.entries()]
      .map(([col, width]) => ({ col, width }))
      .sort((a, b) => a.col - b.col);
  }

  getRowHeight(row: number): number | undefined {
    return this.rowHeights.get(row);
  }

  setRowHeight(row: number, height: number | null): void {
    if (height === null || height <= 0) this.rowHeights.delete(row);
    else this.rowHeights.set(row, Math.min(300, Math.round(height * 100) / 100));
  }

  rows(): { row: number; height: number }[] {
    return [...this.rowHeights.entries()]
      .map(([row, height]) => ({ row, height }))
      .sort((a, b) => a.row - b.row);
  }

  getCell(ref: string | Addr): CellValue {
    const key = typeof ref === "string" ? this.keyOf(ref) : addrKey(ref);
    if (key === null) return err("#REF!", String(ref));
    return this.cells.get(key)?.value ?? null;
  }

  getInput(ref: string | Addr): string {
    const key = typeof ref === "string" ? this.keyOf(ref) : addrKey(ref);
    if (key === null) return "";
    return this.cells.get(key)?.input ?? "";
  }

  getDisplay(ref: string | Addr): string {
    const v = this.getCell(ref);
    if (v === null) return "";
    if (isError(v)) return v.code;
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (typeof v === "number") {
      return formatNumber(v, this.getFormat(ref).numFmt ?? "general");
    }
    return v;
  }

  getFormat(ref: string | Addr): CellFormat {
    const key = typeof ref === "string" ? this.keyOf(ref) : addrKey(ref);
    if (key === null) return {};
    return { ...(this.cells.get(key)?.format ?? {}) };
  }

  /** Merge a format patch into the cell; null values clear keys. Formats are
   *  display-only: values and the dependency graph are untouched. */
  setFormat(ref: string | Addr, patch: Partial<Record<keyof CellFormat, unknown>>): void {
    const key = typeof ref === "string" ? this.keyOf(ref) : addrKey(ref);
    if (key === null) throw new Error(`Invalid cell reference ${String(ref)}`);
    const cell = this.ensure(key);
    const next: CellFormat = { ...(cell.format ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === false || v === "general") {
        delete next[k as keyof CellFormat];
      } else {
        (next as Record<string, unknown>)[k] = v;
      }
    }
    if (Object.keys(next).length === 0) delete cell.format;
    else cell.format = next;
  }

  /** All non-empty cells (input or format), for persistence. */
  entries(): { addr: string; input: string; format?: CellFormat }[] {
    const out: { addr: string; input: string; format?: CellFormat }[] = [];
    for (const [key, cell] of this.cells) {
      if (cell.input !== "" || cell.format) {
        const [col, row] = key.split(":").map(Number);
        const entry: { addr: string; input: string; format?: CellFormat } = {
          addr: formatAddr({ col: col!, row: row! }),
          input: cell.input,
        };
        if (cell.format) entry.format = { ...cell.format };
        out.push(entry);
      }
    }
    return out;
  }

  private keyOf(ref: string): string | null {
    const addr = parseAddr(ref);
    return addr ? addrKey(addr) : null;
  }

  private ensure(key: string): Cell {
    let cell = this.cells.get(key);
    if (!cell) {
      cell = { input: "", formula: null, value: null, deps: new Set(), dependents: new Set() };
      this.cells.set(key, cell);
    }
    return cell;
  }

  setCell(ref: string | Addr, input: string): void {
    const key = typeof ref === "string" ? this.keyOf(ref) : addrKey(ref);
    if (key === null) throw new Error(`Invalid cell reference ${String(ref)}`);
    const cell = this.ensure(key);

    // unlink old deps
    for (const dep of cell.deps) this.cells.get(dep)?.dependents.delete(key);
    cell.deps.clear();

    cell.input = input;
    if (input.startsWith("=")) {
      try {
        cell.formula = parseFormula(input.slice(1));
        const refs = new Set<string>();
        collectRefs(cell.formula, refs);
        cell.deps = refs;
        for (const dep of refs) this.ensure(dep).dependents.add(key);
      } catch (e) {
        cell.formula = null;
        cell.value = err("#PARSE!", e instanceof FormulaError ? e.message : "parse error");
        this.propagate(key);
        return;
      }
    } else {
      cell.formula = null;
      cell.value = parseLiteral(input);
      this.propagate(key);
      return;
    }
    this.recalcFrom(key);
  }

  /** Recalculate `key` and everything downstream, in dependency order. */
  private recalcFrom(startKey: string): void {
    const dirty = this.dirtySet(startKey);
    this.recalcDirty(dirty);
  }

  /** Mark downstream of a value change dirty and recalc (the changed cell itself holds a literal). */
  private propagate(changedKey: string): void {
    const dirty = new Set<string>();
    for (const dep of this.cells.get(changedKey)?.dependents ?? []) {
      for (const k of this.dirtySet(dep)) dirty.add(k);
    }
    this.recalcDirty(dirty);
  }

  private dirtySet(startKey: string): Set<string> {
    const dirty = new Set<string>();
    const stack = [startKey];
    while (stack.length > 0) {
      const key = stack.pop()!;
      if (dirty.has(key)) continue;
      dirty.add(key);
      for (const dependent of this.cells.get(key)?.dependents ?? []) {
        stack.push(dependent);
      }
    }
    return dirty;
  }

  private recalcDirty(dirty: Set<string>): void {
    // Topological evaluation over the dirty subgraph with cycle detection.
    const state = new Map<string, "visiting" | "done">();
    const inCycle = new Set<string>();

    const visit = (key: string): void => {
      const s = state.get(key);
      if (s === "done") return;
      if (s === "visiting") {
        inCycle.add(key);
        return;
      }
      state.set(key, "visiting");
      const cell = this.cells.get(key);
      if (cell) {
        for (const dep of cell.deps) {
          if (dirty.has(dep)) visit(dep);
          if (inCycle.has(dep) && state.get(dep) !== "done") inCycle.add(key);
        }
        if (cell.formula) {
          if (inCycle.has(key)) {
            cell.value = err("#CYCLE!", `circular reference at ${this.nameOf(key)}`);
          } else {
            this.evalCount++;
            cell.value = this.evalAst(cell.formula);
          }
        }
      }
      state.set(key, "done");
    };

    for (const key of dirty) visit(key);

    // Cells discovered to be in a cycle after their evaluation: mark them.
    for (const key of inCycle) {
      const cell = this.cells.get(key);
      if (cell?.formula) cell.value = err("#CYCLE!", `circular reference at ${this.nameOf(key)}`);
    }
  }

  private nameOf(key: string): string {
    const [col, row] = key.split(":").map(Number);
    return formatAddr({ col: col!, row: row! });
  }

  private evalAst(ast: Ast): CellValue {
    switch (ast.t) {
      case "num":
        return ast.v;
      case "str":
        return ast.v;
      case "bool":
        return ast.v;
      case "ref":
        return this.cells.get(addrKey(ast.addr))?.value ?? null;
      case "range":
        return err("#VALUE!", "a range is only valid as a function argument");
      case "un": {
        const v = this.evalAst(ast.v);
        const n = toNumber(v);
        if (typeof n !== "number") return n;
        return ast.op === "-" ? -n : n;
      }
      case "bin":
        return this.evalBin(ast.op, this.evalAst(ast.l), this.evalAst(ast.r));
      case "call": {
        const def = FUNCTIONS[ast.name];
        if (!def) return err("#NAME?", `Unknown function ${ast.name}`);
        if (ast.args.length < def.minArgs || ast.args.length > def.maxArgs) {
          return err("#VALUE!", `${ast.name} takes ${def.minArgs}${def.maxArgs === Infinity ? "+" : `–${def.maxArgs}`} arguments`);
        }
        const args = ast.args.map((a) =>
          a.t === "range"
            ? [...rangeAddrs(a.from, a.to)].map((addr) => this.cells.get(addrKey(addr))?.value ?? null)
            : this.evalAst(a)
        );
        return def.apply(args);
      }
    }
  }

  private evalBin(op: string, l: CellValue, r: CellValue): CellValue {
    if (isError(l)) return l;
    if (isError(r)) return r;
    if (op === "&") return toText(l) + toText(r);
    if (["=", "<>", "<", "<=", ">", ">="].includes(op)) {
      return this.compare(op, l, r);
    }
    const ln = toNumber(l);
    if (typeof ln !== "number") return ln;
    const rn = toNumber(r);
    if (typeof rn !== "number") return rn;
    switch (op) {
      case "+":
        return ln + rn;
      case "-":
        return ln - rn;
      case "*":
        return ln * rn;
      case "/":
        return rn === 0 ? err("#DIV/0!") : ln / rn;
      case "^": {
        const v = Math.pow(ln, rn);
        return Number.isFinite(v) ? v : err("#NUM!");
      }
      default:
        return err("#VALUE!", `unknown operator ${op}`);
    }
  }

  private compare(op: string, l: CellValue, r: CellValue): CellValue {
    const a = l ?? 0;
    const b = r ?? 0;
    let cmp: number;
    if (typeof a === "string" && typeof b === "string") {
      cmp = a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
    } else if (typeof a === "string" || typeof b === "string") {
      // Excel convention: text > number
      cmp = typeof a === "string" ? 1 : -1;
    } else {
      const an = typeof a === "boolean" ? (a ? 1 : 0) : a;
      const bn = typeof b === "boolean" ? (b ? 1 : 0) : b;
      cmp = an < bn ? -1 : an > bn ? 1 : 0;
    }
    switch (op) {
      case "=":
        return cmp === 0;
      case "<>":
        return cmp !== 0;
      case "<":
        return cmp < 0;
      case "<=":
        return cmp <= 0;
      case ">":
        return cmp > 0;
      case ">=":
        return cmp >= 0;
      default:
        return err("#VALUE!");
    }
  }
}
