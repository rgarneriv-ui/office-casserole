/**
 * Function registry (spec §7.2: registry with formal signatures).
 * Arguments arrive pre-evaluated except where lazy = true (IF, AND, OR short-
 * circuit on errors only after their condition is known). Range arguments are
 * flattened value lists. Error values propagate unless a function is defined
 * over them (COUNT-family, IF conditions do not shield errors).
 */

import { CellValue, ErrorValue, err, isError } from "./types";

export type ArgValue = CellValue | CellValue[]; // array = flattened range

export interface FuncDef {
  minArgs: number;
  maxArgs: number; // Infinity for variadic
  apply: (args: ArgValue[]) => CellValue;
}

function flatten(args: ArgValue[]): CellValue[] {
  const out: CellValue[] = [];
  for (const a of args) {
    if (Array.isArray(a)) out.push(...a);
    else out.push(a);
  }
  return out;
}

function firstError(values: CellValue[]): ErrorValue | null {
  for (const v of values) if (isError(v)) return v;
  return null;
}

/** Numeric coercion for aggregate context: numbers only; booleans/strings/empties skipped. */
function numbersIn(values: CellValue[]): number[] {
  return values.filter((v): v is number => typeof v === "number");
}

/** Strict scalar → number for arithmetic-style args. */
export function toNumber(v: CellValue): number | ErrorValue {
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    if (v.trim() === "") return 0;
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
    return err("#VALUE!", `'${v}' is not a number`);
  }
  return v; // error passes through
}

export function toText(v: CellValue): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(v);
  return v.code;
}

function toBool(v: CellValue): boolean | ErrorValue {
  if (isError(v)) return v;
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const upper = v.toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  return err("#VALUE!", `'${v}' is not a logical value`);
}

function aggregate(fn: (nums: number[]) => CellValue): FuncDef["apply"] {
  return (args) => {
    const values = flatten(args);
    const e = firstError(values);
    if (e) return e;
    return fn(numbersIn(values));
  };
}

function numeric1(fn: (n: number) => number | ErrorValue): FuncDef["apply"] {
  return (args) => {
    const v = args[0];
    if (Array.isArray(v)) return err("#VALUE!", "expected a single value, got a range");
    const n = toNumber(v ?? null);
    if (typeof n !== "number") return n;
    return fn(n);
  };
}

export const FUNCTIONS: Record<string, FuncDef> = {
  SUM: { minArgs: 1, maxArgs: Infinity, apply: aggregate((nums) => nums.reduce((a, b) => a + b, 0)) },
  AVERAGE: {
    minArgs: 1,
    maxArgs: Infinity,
    apply: aggregate((nums) => (nums.length === 0 ? err("#DIV/0!", "AVERAGE of no numbers") : nums.reduce((a, b) => a + b, 0) / nums.length)),
  },
  MIN: { minArgs: 1, maxArgs: Infinity, apply: aggregate((nums) => (nums.length === 0 ? 0 : Math.min(...nums))) },
  MAX: { minArgs: 1, maxArgs: Infinity, apply: aggregate((nums) => (nums.length === 0 ? 0 : Math.max(...nums))) },
  COUNT: {
    minArgs: 1,
    maxArgs: Infinity,
    apply: (args) => numbersIn(flatten(args)).length,
  },
  COUNTA: {
    minArgs: 1,
    maxArgs: Infinity,
    apply: (args) => flatten(args).filter((v) => v !== null).length,
  },
  IF: {
    minArgs: 2,
    maxArgs: 3,
    apply: (args) => {
      const cond = Array.isArray(args[0]) ? err("#VALUE!", "IF condition cannot be a range") : toBool(args[0] ?? null);
      if (isError(cond)) return cond;
      const branch = cond ? args[1] : args.length > 2 ? args[2] : false;
      if (Array.isArray(branch)) return err("#VALUE!", "IF branch cannot be a range");
      return branch ?? null;
    },
  },
  AND: {
    minArgs: 1,
    maxArgs: Infinity,
    apply: (args) => {
      const values = flatten(args);
      const e = firstError(values);
      if (e) return e;
      for (const v of values) {
        const b = toBool(v);
        if (isError(b)) return b;
        if (!b) return false;
      }
      return true;
    },
  },
  OR: {
    minArgs: 1,
    maxArgs: Infinity,
    apply: (args) => {
      const values = flatten(args);
      const e = firstError(values);
      if (e) return e;
      for (const v of values) {
        const b = toBool(v);
        if (isError(b)) return b;
        if (b) return true;
      }
      return false;
    },
  },
  NOT: {
    minArgs: 1,
    maxArgs: 1,
    apply: (args) => {
      const v = Array.isArray(args[0]) ? err("#VALUE!", "NOT of a range") : toBool(args[0] ?? null);
      if (isError(v)) return v;
      return !v;
    },
  },
  ABS: { minArgs: 1, maxArgs: 1, apply: numeric1((n) => Math.abs(n)) },
  SQRT: { minArgs: 1, maxArgs: 1, apply: numeric1((n) => (n < 0 ? err("#NUM!", "SQRT of a negative number") : Math.sqrt(n))) },
  ROUND: {
    minArgs: 1,
    maxArgs: 2,
    apply: (args) => {
      const n = Array.isArray(args[0]) ? err("#VALUE!") : toNumber(args[0] ?? null);
      if (typeof n !== "number") return n;
      const dRaw = args.length > 1 ? (Array.isArray(args[1]) ? err("#VALUE!") : toNumber(args[1] ?? null)) : 0;
      if (typeof dRaw !== "number") return dRaw;
      const f = Math.pow(10, Math.trunc(dRaw));
      return Math.round((n + Number.EPSILON) * f) / f;
    },
  },
  LEN: {
    minArgs: 1,
    maxArgs: 1,
    apply: (args) => {
      if (Array.isArray(args[0])) return err("#VALUE!", "LEN of a range");
      const v = args[0] ?? null;
      if (isError(v)) return v;
      return toText(v).length;
    },
  },
  UPPER: {
    minArgs: 1,
    maxArgs: 1,
    apply: (args) => {
      if (Array.isArray(args[0])) return err("#VALUE!");
      const v = args[0] ?? null;
      if (isError(v)) return v;
      return toText(v).toUpperCase();
    },
  },
  LOWER: {
    minArgs: 1,
    maxArgs: 1,
    apply: (args) => {
      if (Array.isArray(args[0])) return err("#VALUE!");
      const v = args[0] ?? null;
      if (isError(v)) return v;
      return toText(v).toLowerCase();
    },
  },
  CONCAT: {
    minArgs: 1,
    maxArgs: Infinity,
    apply: (args) => {
      const values = flatten(args);
      const e = firstError(values);
      if (e) return e;
      return values.map(toText).join("");
    },
  },
};
FUNCTIONS.CONCATENATE = FUNCTIONS.CONCAT!;
