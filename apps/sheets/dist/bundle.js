"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // engines/spreadsheet-calc/src/addr.ts
  function colToName(col) {
    let name = "";
    let c = col;
    for (; ; ) {
      name = String.fromCharCode(65 + c % 26) + name;
      c = Math.floor(c / 26) - 1;
      if (c < 0) break;
    }
    return name;
  }
  function nameToCol(name) {
    let col = 0;
    for (const ch of name.toUpperCase()) {
      col = col * 26 + (ch.charCodeAt(0) - 64);
    }
    return col - 1;
  }
  var ADDR_RE = /^\$?([A-Za-z]{1,3})\$?([0-9]+)$/;
  function parseAddr(text) {
    const m = ADDR_RE.exec(text);
    if (!m) return null;
    const row = parseInt(m[2], 10) - 1;
    if (row < 0) return null;
    return { col: nameToCol(m[1]), row };
  }
  function formatAddr(addr) {
    return `${colToName(addr.col)}${addr.row + 1}`;
  }
  function addrKey(addr) {
    return `${addr.col}:${addr.row}`;
  }
  function* rangeAddrs(from, to) {
    const c0 = Math.min(from.col, to.col);
    const c1 = Math.max(from.col, to.col);
    const r0 = Math.min(from.row, to.row);
    const r1 = Math.max(from.row, to.row);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        yield { col: c, row: r };
      }
    }
  }

  // engines/spreadsheet-calc/src/types.ts
  function isError(v) {
    return typeof v === "object" && v !== null && v.kind === "error";
  }
  function err(code, detail) {
    return { kind: "error", code, detail };
  }

  // engines/spreadsheet-calc/src/functions.ts
  function flatten(args) {
    const out = [];
    for (const a of args) {
      if (Array.isArray(a)) out.push(...a);
      else out.push(a);
    }
    return out;
  }
  function firstError(values) {
    for (const v of values) if (isError(v)) return v;
    return null;
  }
  function numbersIn(values) {
    return values.filter((v) => typeof v === "number");
  }
  function toNumber(v) {
    if (v === null) return 0;
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") {
      if (v.trim() === "") return 0;
      const n = Number(v);
      if (!Number.isNaN(n)) return n;
      return err("#VALUE!", `'${v}' is not a number`);
    }
    return v;
  }
  function toText(v) {
    if (v === null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (typeof v === "number") return String(v);
    return v.code;
  }
  function toBool(v) {
    if (isError(v)) return v;
    if (v === null) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    const upper = v.toUpperCase();
    if (upper === "TRUE") return true;
    if (upper === "FALSE") return false;
    return err("#VALUE!", `'${v}' is not a logical value`);
  }
  function aggregate(fn) {
    return (args) => {
      const values = flatten(args);
      const e = firstError(values);
      if (e) return e;
      return fn(numbersIn(values));
    };
  }
  function numeric1(fn) {
    return (args) => {
      const v = args[0];
      if (Array.isArray(v)) return err("#VALUE!", "expected a single value, got a range");
      const n = toNumber(v ?? null);
      if (typeof n !== "number") return n;
      return fn(n);
    };
  }
  var FUNCTIONS = {
    SUM: { minArgs: 1, maxArgs: Infinity, apply: aggregate((nums) => nums.reduce((a, b) => a + b, 0)) },
    AVERAGE: {
      minArgs: 1,
      maxArgs: Infinity,
      apply: aggregate((nums) => nums.length === 0 ? err("#DIV/0!", "AVERAGE of no numbers") : nums.reduce((a, b) => a + b, 0) / nums.length)
    },
    MIN: { minArgs: 1, maxArgs: Infinity, apply: aggregate((nums) => nums.length === 0 ? 0 : Math.min(...nums)) },
    MAX: { minArgs: 1, maxArgs: Infinity, apply: aggregate((nums) => nums.length === 0 ? 0 : Math.max(...nums)) },
    COUNT: {
      minArgs: 1,
      maxArgs: Infinity,
      apply: (args) => numbersIn(flatten(args)).length
    },
    COUNTA: {
      minArgs: 1,
      maxArgs: Infinity,
      apply: (args) => flatten(args).filter((v) => v !== null).length
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
      }
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
      }
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
      }
    },
    NOT: {
      minArgs: 1,
      maxArgs: 1,
      apply: (args) => {
        const v = Array.isArray(args[0]) ? err("#VALUE!", "NOT of a range") : toBool(args[0] ?? null);
        if (isError(v)) return v;
        return !v;
      }
    },
    ABS: { minArgs: 1, maxArgs: 1, apply: numeric1((n) => Math.abs(n)) },
    SQRT: { minArgs: 1, maxArgs: 1, apply: numeric1((n) => n < 0 ? err("#NUM!", "SQRT of a negative number") : Math.sqrt(n)) },
    ROUND: {
      minArgs: 1,
      maxArgs: 2,
      apply: (args) => {
        const n = Array.isArray(args[0]) ? err("#VALUE!") : toNumber(args[0] ?? null);
        if (typeof n !== "number") return n;
        const dRaw = args.length > 1 ? Array.isArray(args[1]) ? err("#VALUE!") : toNumber(args[1] ?? null) : 0;
        if (typeof dRaw !== "number") return dRaw;
        const f = Math.pow(10, Math.trunc(dRaw));
        return Math.round((n + Number.EPSILON) * f) / f;
      }
    },
    LEN: {
      minArgs: 1,
      maxArgs: 1,
      apply: (args) => {
        if (Array.isArray(args[0])) return err("#VALUE!", "LEN of a range");
        const v = args[0] ?? null;
        if (isError(v)) return v;
        return toText(v).length;
      }
    },
    UPPER: {
      minArgs: 1,
      maxArgs: 1,
      apply: (args) => {
        if (Array.isArray(args[0])) return err("#VALUE!");
        const v = args[0] ?? null;
        if (isError(v)) return v;
        return toText(v).toUpperCase();
      }
    },
    LOWER: {
      minArgs: 1,
      maxArgs: 1,
      apply: (args) => {
        if (Array.isArray(args[0])) return err("#VALUE!");
        const v = args[0] ?? null;
        if (isError(v)) return v;
        return toText(v).toLowerCase();
      }
    },
    CONCAT: {
      minArgs: 1,
      maxArgs: Infinity,
      apply: (args) => {
        const values = flatten(args);
        const e = firstError(values);
        if (e) return e;
        return values.map(toText).join("");
      }
    }
  };
  FUNCTIONS.CONCATENATE = FUNCTIONS.CONCAT;

  // engines/spreadsheet-calc/src/parse.ts
  var FormulaError = class extends Error {
  };
  var OPS = ["<>", "<=", ">=", "=", "<", ">", "+", "-", "*", "/", "^", "&", "(", ")", ",", ":"];
  function tokenize(src) {
    const tokens = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === " " || ch === "	" || ch === "\n") {
        i++;
        continue;
      }
      if (ch >= "0" && ch <= "9") {
        const m2 = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i));
        tokens.push({ kind: "num", text: m2[0], pos: i });
        i += m2[0].length;
        continue;
      }
      if (ch === ".") {
        const m2 = /^\.[0-9]+([eE][+-]?[0-9]+)?/.exec(src.slice(i));
        if (m2) {
          tokens.push({ kind: "num", text: m2[0], pos: i });
          i += m2[0].length;
          continue;
        }
        throw new FormulaError(`Unexpected '.' at ${i}`);
      }
      if (ch === '"') {
        let j = i + 1;
        let out = "";
        for (; ; ) {
          if (j >= src.length) throw new FormulaError("Unterminated string");
          if (src[j] === '"') {
            if (src[j + 1] === '"') {
              out += '"';
              j += 2;
              continue;
            }
            break;
          }
          out += src[j];
          j++;
        }
        tokens.push({ kind: "str", text: out, pos: i });
        i = j + 1;
        continue;
      }
      const op = OPS.find((o) => src.startsWith(o, i));
      if (op) {
        tokens.push({ kind: "op", text: op, pos: i });
        i += op.length;
        continue;
      }
      const m = /^[A-Za-z_][A-Za-z0-9_.$]*|^\$[A-Za-z]{1,3}\$?[0-9]+/.exec(src.slice(i));
      if (m) {
        tokens.push({ kind: "ident", text: m[0], pos: i });
        i += m[0].length;
        continue;
      }
      throw new FormulaError(`Unexpected character '${ch}' at ${i}`);
    }
    return tokens;
  }
  function parseFormula(src) {
    const tokens = tokenize(src);
    let pos = 0;
    const peek = () => tokens[pos] ?? null;
    const take = () => {
      const t = tokens[pos];
      if (!t) throw new FormulaError("Unexpected end of formula");
      pos++;
      return t;
    };
    const takeOp = (text) => {
      const t = take();
      if (t.kind !== "op" || t.text !== text) {
        throw new FormulaError(`Expected '${text}' at ${t.pos}`);
      }
    };
    function primary() {
      const t = take();
      if (t.kind === "num") return { t: "num", v: parseFloat(t.text) };
      if (t.kind === "str") return { t: "str", v: t.text };
      if (t.kind === "op" && t.text === "(") {
        const inner = compare();
        takeOp(")");
        return inner;
      }
      if (t.kind === "op" && (t.text === "-" || t.text === "+")) {
        return { t: "un", op: t.text, v: unary() };
      }
      if (t.kind === "ident") {
        const upper = t.text.toUpperCase();
        if (upper === "TRUE") return { t: "bool", v: true };
        if (upper === "FALSE") return { t: "bool", v: false };
        const next = peek();
        if (next && next.kind === "op" && next.text === "(") {
          take();
          const args = [];
          if (!(peek()?.kind === "op" && peek()?.text === ")")) {
            for (; ; ) {
              args.push(compare());
              const n = peek();
              if (n && n.kind === "op" && n.text === ",") {
                take();
                continue;
              }
              break;
            }
          }
          takeOp(")");
          return { t: "call", name: upper, args };
        }
        const addr = parseAddr(t.text);
        if (addr) {
          const n = peek();
          if (n && n.kind === "op" && n.text === ":") {
            take();
            const t2 = take();
            const addr2 = t2.kind === "ident" ? parseAddr(t2.text) : null;
            if (!addr2) throw new FormulaError(`Expected cell reference after ':' at ${t2.pos}`);
            return { t: "range", from: addr, to: addr2 };
          }
          return { t: "ref", addr };
        }
        throw new FormulaError(`Unknown name '${t.text}'`);
      }
      throw new FormulaError(`Unexpected token '${t.text}' at ${t.pos}`);
    }
    function unary() {
      const t = peek();
      if (t && t.kind === "op" && (t.text === "-" || t.text === "+")) {
        take();
        return { t: "un", op: t.text, v: unary() };
      }
      return primary();
    }
    function power() {
      const base = unary();
      const t = peek();
      if (t && t.kind === "op" && t.text === "^") {
        take();
        return { t: "bin", op: "^", l: base, r: power() };
      }
      return base;
    }
    const binLevel = (ops, next) => () => {
      let left = next();
      for (; ; ) {
        const t = peek();
        if (t && t.kind === "op" && ops.includes(t.text)) {
          take();
          left = { t: "bin", op: t.text, l: left, r: next() };
        } else {
          return left;
        }
      }
    };
    const muldiv = binLevel(["*", "/"], power);
    const addsub = binLevel(["+", "-"], muldiv);
    const concat = binLevel(["&"], addsub);
    const compare = binLevel(["=", "<>", "<", "<=", ">", ">="], concat);
    const ast = compare();
    if (pos !== tokens.length) {
      throw new FormulaError(`Unexpected trailing input at ${tokens[pos].pos}`);
    }
    return ast;
  }

  // engines/spreadsheet-calc/src/engine.ts
  function formatNumber(v, fmt) {
    const grouped = (n, dec) => n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
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
  function collectRefs(ast, out) {
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
  function parseLiteral(input) {
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
  var Sheet = class {
    constructor() {
      __publicField(this, "cells", /* @__PURE__ */ new Map());
      /** column widths in Excel character units (default ≈ 8.43) */
      __publicField(this, "colWidths", /* @__PURE__ */ new Map());
      /** row heights in points (default ≈ 15) */
      __publicField(this, "rowHeights", /* @__PURE__ */ new Map());
      /** total formula evaluations — exposed so tests can prove incrementality */
      __publicField(this, "evalCount", 0);
    }
    getColWidth(col) {
      return this.colWidths.get(col);
    }
    setColWidth(col, width) {
      if (width === null || width <= 0) this.colWidths.delete(col);
      else this.colWidths.set(col, Math.min(120, Math.round(width * 100) / 100));
    }
    cols() {
      return [...this.colWidths.entries()].map(([col, width]) => ({ col, width })).sort((a, b) => a.col - b.col);
    }
    getRowHeight(row) {
      return this.rowHeights.get(row);
    }
    setRowHeight(row, height) {
      if (height === null || height <= 0) this.rowHeights.delete(row);
      else this.rowHeights.set(row, Math.min(300, Math.round(height * 100) / 100));
    }
    rows() {
      return [...this.rowHeights.entries()].map(([row, height]) => ({ row, height })).sort((a, b) => a.row - b.row);
    }
    getCell(ref) {
      const key = typeof ref === "string" ? this.keyOf(ref) : addrKey(ref);
      if (key === null) return err("#REF!", String(ref));
      return this.cells.get(key)?.value ?? null;
    }
    getInput(ref) {
      const key = typeof ref === "string" ? this.keyOf(ref) : addrKey(ref);
      if (key === null) return "";
      return this.cells.get(key)?.input ?? "";
    }
    getDisplay(ref) {
      const v = this.getCell(ref);
      if (v === null) return "";
      if (isError(v)) return v.code;
      if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
      if (typeof v === "number") {
        return formatNumber(v, this.getFormat(ref).numFmt ?? "general");
      }
      return v;
    }
    getFormat(ref) {
      const key = typeof ref === "string" ? this.keyOf(ref) : addrKey(ref);
      if (key === null) return {};
      return { ...this.cells.get(key)?.format ?? {} };
    }
    /** Merge a format patch into the cell; null values clear keys. Formats are
     *  display-only: values and the dependency graph are untouched. */
    setFormat(ref, patch) {
      const key = typeof ref === "string" ? this.keyOf(ref) : addrKey(ref);
      if (key === null) throw new Error(`Invalid cell reference ${String(ref)}`);
      const cell = this.ensure(key);
      const next = { ...cell.format ?? {} };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === void 0 || v === false || v === "general") {
          delete next[k];
        } else {
          next[k] = v;
        }
      }
      if (Object.keys(next).length === 0) delete cell.format;
      else cell.format = next;
    }
    /** All non-empty cells (input or format), for persistence. */
    entries() {
      const out = [];
      for (const [key, cell] of this.cells) {
        if (cell.input !== "" || cell.format) {
          const [col, row] = key.split(":").map(Number);
          const entry = {
            addr: formatAddr({ col, row }),
            input: cell.input
          };
          if (cell.format) entry.format = { ...cell.format };
          out.push(entry);
        }
      }
      return out;
    }
    keyOf(ref) {
      const addr = parseAddr(ref);
      return addr ? addrKey(addr) : null;
    }
    ensure(key) {
      let cell = this.cells.get(key);
      if (!cell) {
        cell = { input: "", formula: null, value: null, deps: /* @__PURE__ */ new Set(), dependents: /* @__PURE__ */ new Set() };
        this.cells.set(key, cell);
      }
      return cell;
    }
    setCell(ref, input) {
      const key = typeof ref === "string" ? this.keyOf(ref) : addrKey(ref);
      if (key === null) throw new Error(`Invalid cell reference ${String(ref)}`);
      const cell = this.ensure(key);
      for (const dep of cell.deps) this.cells.get(dep)?.dependents.delete(key);
      cell.deps.clear();
      cell.input = input;
      if (input.startsWith("=")) {
        try {
          cell.formula = parseFormula(input.slice(1));
          const refs = /* @__PURE__ */ new Set();
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
    recalcFrom(startKey) {
      const dirty = this.dirtySet(startKey);
      this.recalcDirty(dirty);
    }
    /** Mark downstream of a value change dirty and recalc (the changed cell itself holds a literal). */
    propagate(changedKey) {
      const dirty = /* @__PURE__ */ new Set();
      for (const dep of this.cells.get(changedKey)?.dependents ?? []) {
        for (const k of this.dirtySet(dep)) dirty.add(k);
      }
      this.recalcDirty(dirty);
    }
    dirtySet(startKey) {
      const dirty = /* @__PURE__ */ new Set();
      const stack = [startKey];
      while (stack.length > 0) {
        const key = stack.pop();
        if (dirty.has(key)) continue;
        dirty.add(key);
        for (const dependent of this.cells.get(key)?.dependents ?? []) {
          stack.push(dependent);
        }
      }
      return dirty;
    }
    recalcDirty(dirty) {
      const state = /* @__PURE__ */ new Map();
      const inCycle = /* @__PURE__ */ new Set();
      const visit = (key) => {
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
      for (const key of inCycle) {
        const cell = this.cells.get(key);
        if (cell?.formula) cell.value = err("#CYCLE!", `circular reference at ${this.nameOf(key)}`);
      }
    }
    nameOf(key) {
      const [col, row] = key.split(":").map(Number);
      return formatAddr({ col, row });
    }
    evalAst(ast) {
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
            return err("#VALUE!", `${ast.name} takes ${def.minArgs}${def.maxArgs === Infinity ? "+" : `\u2013${def.maxArgs}`} arguments`);
          }
          const args = ast.args.map(
            (a) => a.t === "range" ? [...rangeAddrs(a.from, a.to)].map((addr) => this.cells.get(addrKey(addr))?.value ?? null) : this.evalAst(a)
          );
          return def.apply(args);
        }
      }
    }
    evalBin(op, l, r) {
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
    compare(op, l, r) {
      const a = l ?? 0;
      const b = r ?? 0;
      let cmp;
      if (typeof a === "string" && typeof b === "string") {
        cmp = a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
      } else if (typeof a === "string" || typeof b === "string") {
        cmp = typeof a === "string" ? 1 : -1;
      } else {
        const an = typeof a === "boolean" ? a ? 1 : 0 : a;
        const bn = typeof b === "boolean" ? b ? 1 : 0 : b;
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
  };

  // engines/spreadsheet-calc/src/clipboard.ts
  var REF_RE = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)$/;
  function shiftFormula(body, dRow, dCol) {
    let tokens;
    try {
      tokens = tokenize(body);
    } catch {
      return body;
    }
    const edits = [];
    tokens.forEach((tok, i) => {
      if (tok.kind !== "ident") return;
      const isCall = tokens[i + 1]?.kind === "op" && tokens[i + 1]?.text === "(";
      if (isCall) return;
      const m = REF_RE.exec(tok.text);
      if (!m || !parseAddr(tok.text)) return;
      const colAnchored = m[1] === "$";
      const rowAnchored = m[3] === "$";
      let col = nameToCol(m[2]);
      let row = parseInt(m[4], 10) - 1;
      if (!colAnchored) col += dCol;
      if (!rowAnchored) row += dRow;
      const repl = col < 0 || row < 0 ? "#REF!" : `${colAnchored ? "$" : ""}${colToName(col)}${rowAnchored ? "$" : ""}${row + 1}`;
      edits.push({ start: tok.pos, end: tok.pos + tok.text.length, repl });
    });
    let out = "";
    let cursor = 0;
    for (const e of edits) {
      out += body.slice(cursor, e.start) + e.repl;
      cursor = e.end;
    }
    return out + body.slice(cursor);
  }
  function normalizeRect(aAddr, bAddr) {
    const a = parseAddr(aAddr);
    const b = parseAddr(bAddr);
    return {
      r0: Math.min(a.row, b.row),
      c0: Math.min(a.col, b.col),
      r1: Math.max(a.row, b.row),
      c1: Math.max(a.col, b.col)
    };
  }
  function copyRange(sheet2, rect) {
    const cells = [];
    for (let r = rect.r0; r <= rect.r1; r++) {
      for (let c = rect.c0; c <= rect.c1; c++) {
        const addr = formatAddr({ col: c, row: r });
        const input = sheet2.getInput(addr);
        const format = sheet2.getFormat(addr);
        if (input !== "" || Object.keys(format).length > 0) {
          const cell = { dRow: r - rect.r0, dCol: c - rect.c0, input };
          if (Object.keys(format).length > 0) cell.format = format;
          cells.push(cell);
        }
      }
    }
    return {
      rows: rect.r1 - rect.r0 + 1,
      cols: rect.c1 - rect.c0 + 1,
      srcRow: rect.r0,
      srcCol: rect.c0,
      cells
    };
  }
  function clearRange(sheet2, rect) {
    for (let r = rect.r0; r <= rect.r1; r++) {
      for (let c = rect.c0; c <= rect.c1; c++) {
        const addr = formatAddr({ col: c, row: r });
        if (sheet2.getInput(addr) !== "") sheet2.setCell(addr, "");
      }
    }
  }
  function pasteClip(sheet2, clip2, atAddr) {
    const at = parseAddr(atAddr);
    const dRow = at.row - clip2.srcRow;
    const dCol = at.col - clip2.srcCol;
    const rect = {
      r0: at.row,
      c0: at.col,
      r1: at.row + clip2.rows - 1,
      c1: at.col + clip2.cols - 1
    };
    clearRange(sheet2, rect);
    for (const cell of clip2.cells) {
      const addr = formatAddr({ col: at.col + cell.dCol, row: at.row + cell.dRow });
      let input = cell.input;
      if (input.startsWith("=")) {
        input = "=" + shiftFormula(input.slice(1), dRow, dCol);
      }
      if (input !== "") sheet2.setCell(addr, input);
      if (cell.format) sheet2.setFormat(addr, cell.format);
    }
    return rect;
  }
  function rangeToTSV(sheet2, rect) {
    const lines = [];
    for (let r = rect.r0; r <= rect.r1; r++) {
      const row = [];
      for (let c = rect.c0; c <= rect.c1; c++) {
        row.push(sheet2.getDisplay(formatAddr({ col: c, row: r })).replace(/[\t\n]/g, " "));
      }
      lines.push(row.join("	"));
    }
    return lines.join("\n");
  }
  function pasteTSV(sheet2, tsv, atAddr) {
    const at = parseAddr(atAddr);
    const rows = tsv.replace(/\r/g, "").replace(/\n$/, "").split("\n");
    let maxCols = 1;
    rows.forEach((line, r) => {
      const cells = line.split("	");
      maxCols = Math.max(maxCols, cells.length);
      cells.forEach((value, c) => {
        sheet2.setCell(formatAddr({ col: at.col + c, row: at.row + r }), value);
      });
    });
    return { r0: at.row, c0: at.col, r1: at.row + rows.length - 1, c1: at.col + maxCols - 1 };
  }
  function isPlainNumber(input) {
    return input !== "" && !input.startsWith("=") && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(input.trim());
  }
  function fillRange(sheet2, src, dest) {
    const down = dest.r0 > src.r1;
    const laneCount = down ? src.c1 - src.c0 + 1 : src.r1 - src.r0 + 1;
    const patternLen = down ? src.r1 - src.r0 + 1 : src.c1 - src.c0 + 1;
    const destLen = down ? dest.r1 - dest.r0 + 1 : dest.c1 - dest.c0 + 1;
    for (let lane = 0; lane < laneCount; lane++) {
      const srcAddr = (i) => down ? formatAddr({ col: src.c0 + lane, row: src.r0 + i }) : formatAddr({ col: src.c0 + i, row: src.r0 + lane });
      const destAddr = (i) => down ? formatAddr({ col: dest.c0 + lane, row: dest.r0 + i }) : formatAddr({ col: dest.c0 + i, row: dest.r0 + lane });
      const inputs = Array.from({ length: patternLen }, (_, i) => sheet2.getInput(srcAddr(i)));
      let series = null;
      if (patternLen >= 2 && inputs.every(isPlainNumber)) {
        const nums = inputs.map(Number);
        const step = nums[1] - nums[0];
        if (nums.every((v, i) => i === 0 || Math.abs(v - nums[i - 1] - step) < 1e-9)) {
          series = { start: nums[nums.length - 1], step };
        }
      }
      for (let i = 0; i < destLen; i++) {
        const target = destAddr(i);
        if (series) {
          const value = series.start + series.step * (i + 1);
          sheet2.setCell(target, String(Math.round(value * 1e10) / 1e10));
        } else {
          const pi = i % patternLen;
          let input = inputs[pi];
          if (input.startsWith("=")) {
            const from = parseAddr(srcAddr(pi));
            const to = parseAddr(target);
            input = "=" + shiftFormula(input.slice(1), to.row - from.row, to.col - from.col);
          }
          sheet2.setCell(target, input);
        }
        const fmt = sheet2.getFormat(srcAddr(series ? patternLen - 1 : i % patternLen));
        if (Object.keys(fmt).length > 0) sheet2.setFormat(target, fmt);
      }
    }
  }
  function sortRange(sheet2, rect, descending = false) {
    const rows = [];
    for (let r = rect.r0; r <= rect.r1; r++) {
      const cells = [];
      for (let c = rect.c0; c <= rect.c1; c++) {
        const addr = formatAddr({ col: c, row: r });
        cells.push({ input: sheet2.getInput(addr), format: sheet2.getFormat(addr), srcRow: r });
      }
      rows.push({ key: sheet2.getCell(formatAddr({ col: rect.c0, row: r })), cells });
    }
    const rank = (k) => k === null || k === "" ? 2 : typeof k === "number" ? 0 : 1;
    rows.sort((a, b) => {
      const ra = rank(a.key);
      const rb = rank(b.key);
      if (ra === 2 || rb === 2) return ra - rb;
      if (ra !== rb) return descending ? rb - ra : ra - rb;
      let cmp;
      if (ra === 0) cmp = a.key - b.key;
      else cmp = String(a.key).localeCompare(String(b.key), void 0, { sensitivity: "base" });
      return descending ? -cmp : cmp;
    });
    rows.forEach((row, i) => {
      const destRow = rect.r0 + i;
      row.cells.forEach((cell, j) => {
        const addr = formatAddr({ col: rect.c0 + j, row: destRow });
        let input = cell.input;
        if (input.startsWith("=")) {
          input = "=" + shiftFormula(input.slice(1), destRow - cell.srcRow, 0);
        }
        sheet2.setCell(addr, input);
        sheet2.setFormat(addr, Object.keys(cell.format).length > 0 ? cell.format : { bold: null, align: null, numFmt: null });
      });
    });
  }

  // engines/format-conversion/src/zip.ts
  var CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  function crc32(data) {
    let crc = 4294967295;
    for (let i = 0; i < data.length; i++) {
      crc = CRC_TABLE[(crc ^ data[i]) & 255] ^ crc >>> 8;
    }
    return (crc ^ 4294967295) >>> 0;
  }
  async function pipeThrough(data, stream) {
    const src = new Blob([data]).stream();
    const buf = await new Response(src.pipeThrough(stream)).arrayBuffer();
    return new Uint8Array(buf);
  }
  async function deflateRaw(data) {
    if (typeof CompressionStream === "undefined") return null;
    return pipeThrough(data, new CompressionStream("deflate-raw"));
  }
  async function inflateRaw(data) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("Cannot read compressed ZIP entries: DecompressionStream unavailable");
    }
    return pipeThrough(data, new DecompressionStream("deflate-raw"));
  }
  var textEncoder = new TextEncoder();
  async function zipWrite(entries) {
    const prepared = [];
    const chunks = [];
    let offset = 0;
    for (const entry of entries) {
      const nameBytes = textEncoder.encode(entry.name);
      const crc = crc32(entry.data);
      const deflated = await deflateRaw(entry.data);
      const useDeflate = deflated !== null && deflated.length < entry.data.length;
      const raw = useDeflate ? deflated : entry.data;
      const method = useDeflate ? 8 : 0;
      const header = new DataView(new ArrayBuffer(30));
      header.setUint32(0, 67324752, true);
      header.setUint16(4, 20, true);
      header.setUint16(6, 0, true);
      header.setUint16(8, method, true);
      header.setUint16(10, 0, true);
      header.setUint16(12, 33, true);
      header.setUint32(14, crc, true);
      header.setUint32(18, raw.length, true);
      header.setUint32(22, entry.data.length, true);
      header.setUint16(26, nameBytes.length, true);
      header.setUint16(28, 0, true);
      prepared.push({ nameBytes, data: entry.data, raw, method, crc, offset });
      chunks.push(new Uint8Array(header.buffer), nameBytes, raw);
      offset += 30 + nameBytes.length + raw.length;
    }
    const cdStart = offset;
    for (const p of prepared) {
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 33639248, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0, true);
      cd.setUint16(10, p.method, true);
      cd.setUint16(12, 0, true);
      cd.setUint16(14, 33, true);
      cd.setUint32(16, p.crc, true);
      cd.setUint32(20, p.raw.length, true);
      cd.setUint32(24, p.data.length, true);
      cd.setUint16(28, p.nameBytes.length, true);
      cd.setUint16(30, 0, true);
      cd.setUint16(32, 0, true);
      cd.setUint16(34, 0, true);
      cd.setUint16(36, 0, true);
      cd.setUint32(38, 0, true);
      cd.setUint32(42, p.offset, true);
      chunks.push(new Uint8Array(cd.buffer), p.nameBytes);
      offset += 46 + p.nameBytes.length;
    }
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 101010256, true);
    eocd.setUint16(4, 0, true);
    eocd.setUint16(6, 0, true);
    eocd.setUint16(8, prepared.length, true);
    eocd.setUint16(10, prepared.length, true);
    eocd.setUint32(12, offset - cdStart, true);
    eocd.setUint32(16, cdStart, true);
    eocd.setUint16(20, 0, true);
    chunks.push(new Uint8Array(eocd.buffer));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }
  var textDecoder = new TextDecoder();
  async function zipRead(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    const scanFloor = Math.max(0, bytes.length - 65558);
    for (let i = bytes.length - 22; i >= scanFloor; i--) {
      if (view.getUint32(i, true) === 101010256) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("Not a ZIP archive (no end-of-central-directory record)");
    const count = view.getUint16(eocd + 10, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (view.getUint32(p, true) !== 33639248) {
        throw new Error("Corrupt ZIP: bad central-directory signature");
      }
      const method = view.getUint16(p + 10, true);
      const crc = view.getUint32(p + 16, true);
      const compSize = view.getUint32(p + 20, true);
      const uncompSize = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const name = textDecoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = bytes.subarray(dataStart, dataStart + compSize);
      let data;
      if (method === 0) data = new Uint8Array(raw);
      else if (method === 8) data = await inflateRaw(new Uint8Array(raw));
      else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
      if (data.length !== uncompSize) {
        throw new Error(`Corrupt ZIP entry ${name}: size mismatch`);
      }
      if (crc32(data) !== crc) {
        throw new Error(`Corrupt ZIP entry ${name}: CRC mismatch`);
      }
      entries.push({ name, data });
    }
    return entries;
  }

  // engines/format-conversion/src/xlsx.ts
  var textEncoder2 = new TextEncoder();
  var textDecoder2 = new TextDecoder();
  function xmlEscape(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  var XLSX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  var XLSX_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  var XLSX_WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  var XLSX_WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  var NUM_FMT_CODES = {
    number2: { id: 164, code: "#,##0.00" },
    currency: { id: 165, code: "&quot;$&quot;#,##0.00" },
    percent: { id: 166, code: "0.00%" }
  };
  var XF_NUMFMTS = ["general", "number2", "currency", "percent"];
  function styleIndexFor(format) {
    if (!format || !format.bold && !format.numFmt) return 0;
    const fontBit = format.bold ? 1 : 0;
    const nf = XF_NUMFMTS.indexOf(format.numFmt ?? "general");
    return 1 + fontBit * 4 + Math.max(0, nf);
  }
  var XLSX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3">` + Object.values(NUM_FMT_CODES).map((f) => `<numFmt numFmtId="${f.id}" formatCode="${f.code}"/>`).join("") + `</numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="9"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` + [0, 1].map(
    (fontId) => XF_NUMFMTS.map((nf) => {
      const numFmtId = nf === "general" ? 0 : NUM_FMT_CODES[nf].id;
      return `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="0" borderId="0" xfId="0" applyFont="${fontId}" applyNumberFormat="${numFmtId ? 1 : 0}"/>`;
    }).join("")
  ).join("") + `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  function cellXml(addr, input, sheet2) {
    const value = sheet2.getCell(addr);
    const si = styleIndexFor(sheet2.getFormat(addr));
    const sAttr = si > 0 ? ` s="${si}"` : "";
    if (input.startsWith("=")) {
      const f = `<f>${xmlEscape(input.slice(1))}</f>`;
      if (isError(value)) return `<c r="${addr}"${sAttr} t="e">${f}<v>${value.code}</v></c>`;
      if (typeof value === "number") return `<c r="${addr}"${sAttr}>${f}<v>${value}</v></c>`;
      if (typeof value === "boolean") return `<c r="${addr}"${sAttr} t="b">${f}<v>${value ? 1 : 0}</v></c>`;
      if (typeof value === "string")
        return `<c r="${addr}"${sAttr} t="str">${f}<v>${xmlEscape(value)}</v></c>`;
      return `<c r="${addr}"${sAttr}>${f}</c>`;
    }
    if (typeof value === "number") return `<c r="${addr}"${sAttr}><v>${value}</v></c>`;
    if (typeof value === "boolean") return `<c r="${addr}"${sAttr} t="b"><v>${value ? 1 : 0}</v></c>`;
    if (typeof value === "string")
      return `<c r="${addr}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    if (si > 0) return `<c r="${addr}" s="${si}"/>`;
    return null;
  }
  async function exportXlsx(sheet2) {
    const rows = /* @__PURE__ */ new Map();
    for (const { addr, input } of sheet2.entries()) {
      const a = parseAddr(addr);
      const xml = cellXml(addr, input, sheet2);
      if (!xml) continue;
      if (!rows.has(a.row)) rows.set(a.row, []);
      rows.get(a.row).push({ col: a.col, xml });
    }
    for (const { row } of sheet2.rows()) {
      if (!rows.has(row)) rows.set(row, []);
    }
    const rowXml = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([r, cells]) => {
      const ht = sheet2.getRowHeight(r);
      const htAttr = ht ? ` ht="${ht}" customHeight="1"` : "";
      return `<row r="${r + 1}"${htAttr}>${cells.sort((a, b) => a.col - b.col).map((c) => c.xml).join("")}</row>`;
    }).join("");
    const colDefs = sheet2.cols();
    const colsXml = colDefs.length > 0 ? `<cols>${colDefs.map((c) => `<col min="${c.col + 1}" max="${c.col + 1}" width="${c.width}" customWidth="1"/>`).join("")}</cols>` : "";
    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${colsXml}<sheetData>${rowXml}</sheetData></worksheet>`;
    const entries = [
      { name: "[Content_Types].xml", data: textEncoder2.encode(XLSX_CONTENT_TYPES) },
      { name: "_rels/.rels", data: textEncoder2.encode(XLSX_ROOT_RELS) },
      { name: "xl/workbook.xml", data: textEncoder2.encode(XLSX_WORKBOOK) },
      { name: "xl/_rels/workbook.xml.rels", data: textEncoder2.encode(XLSX_WORKBOOK_RELS) },
      { name: "xl/styles.xml", data: textEncoder2.encode(XLSX_STYLES) },
      { name: "xl/worksheets/sheet1.xml", data: textEncoder2.encode(sheetXml) }
    ];
    return { bytes: await zipWrite(entries), report: { format: "xlsx", lossless: true, warnings: [] } };
  }
  function defaultParse(xml) {
    if (typeof DOMParser === "undefined") {
      throw new Error("No XML parser available: pass parseXml to importXlsx");
    }
    return new DOMParser().parseFromString(xml, "application/xml");
  }
  function descendants(el, name) {
    const out = [];
    const walk = (e) => {
      const children = e.children ?? [];
      for (let i = 0; i < children.length; i++) {
        const c = children[i];
        if (c.localName === name) out.push(c);
        walk(c);
      }
    };
    walk(el);
    return out;
  }
  function firstChild(el, name) {
    for (let i = 0; i < el.children.length; i++) {
      if (el.children[i].localName === name) return el.children[i];
    }
    return null;
  }
  async function importXlsx(bytes, parseXml = defaultParse) {
    const warnings = [];
    const entries = await zipRead(bytes);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const workbookEntry = byName.get("xl/workbook.xml");
    if (!workbookEntry) throw new Error("Not an XLSX package: xl/workbook.xml missing");
    const xfTable = [];
    const stylesEntry = byName.get("xl/styles.xml");
    if (stylesEntry) {
      try {
        const dom = parseXml(textDecoder2.decode(stylesEntry.data));
        const numFmtCodes = /* @__PURE__ */ new Map();
        for (const nf of descendants(dom, "numFmt")) {
          numFmtCodes.set(Number(nf.getAttribute("numFmtId")), nf.getAttribute("formatCode") ?? "");
        }
        const fonts = [];
        const fontsEl = descendants(dom, "fonts")[0];
        if (fontsEl) {
          for (const f of descendants(fontsEl, "font")) {
            const names = Array.from(f.children).map((c) => c.localName);
            fonts.push({
              bold: names.includes("b"),
              other: names.filter((n) => ["i", "u", "strike", "color"].includes(n))
            });
          }
        }
        const BUILTIN_NUMFMT = {
          2: "number2",
          4: "number2",
          39: "number2",
          40: "number2",
          9: "percent",
          10: "percent",
          5: "currency",
          6: "currency",
          7: "currency",
          8: "currency",
          44: "currency"
        };
        const classifyNumFmt = (id) => {
          if (id === 0) return {};
          if (BUILTIN_NUMFMT[id]) return { fmt: BUILTIN_NUMFMT[id] };
          const code = numFmtCodes.get(id);
          if (code !== void 0) {
            if (code.includes("%")) return { fmt: "percent" };
            if (code.includes("$") || code.includes("\xA4") || code.toLowerCase().includes("[$")) return { fmt: "currency" };
            if (/^#,##0\.0+$|^0\.0+$|^#,##0$/.test(code)) return { fmt: "number2" };
            return { dropped: `number format "${code}"` };
          }
          return { dropped: `number format id ${id}` };
        };
        const cellXfsEl = descendants(dom, "cellXfs")[0];
        if (cellXfsEl) {
          for (const xf of descendants(cellXfsEl, "xf")) {
            const info = { format: {}, dropped: [] };
            const font = fonts[Number(xf.getAttribute("fontId") ?? 0)];
            if (font?.bold) info.format.bold = true;
            if (font && font.other.length > 0) info.dropped.push(...font.other.map((n) => `font ${n}`));
            const nf = classifyNumFmt(Number(xf.getAttribute("numFmtId") ?? 0));
            if (nf.fmt) info.format.numFmt = nf.fmt;
            if (nf.dropped) info.dropped.push(nf.dropped);
            const alignEl = descendants(xf, "alignment")[0];
            const horizontal = alignEl?.getAttribute("horizontal");
            if (horizontal === "left" || horizontal === "center" || horizontal === "right") {
              info.format.align = horizontal;
            }
            if (Number(xf.getAttribute("fillId") ?? 0) > 1) info.dropped.push("fill");
            if (Number(xf.getAttribute("borderId") ?? 0) > 0) info.dropped.push("border");
            xfTable.push(info);
          }
        }
      } catch {
      }
    }
    const droppedAspects = /* @__PURE__ */ new Set();
    const shared = [];
    const sst = byName.get("xl/sharedStrings.xml");
    if (sst) {
      const dom = parseXml(textDecoder2.decode(sst.data));
      for (const si of descendants(dom, "si")) {
        shared.push(descendants(si, "t").map((t) => t.textContent ?? "").join(""));
      }
    }
    const workbook = parseXml(textDecoder2.decode(workbookEntry.data));
    const sheetTags = descendants(workbook, "sheet");
    if (sheetTags.length > 1) {
      warnings.push({
        code: "XLSX-IMPORT-SHEETS",
        message: `Workbook has ${sheetTags.length} sheets; only the first was imported.`,
        blockIndex: -1
      });
    }
    const wsName = [...byName.keys()].find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n)) ?? [...byName.keys()].find((n) => /^xl\/worksheets\/.*\.xml$/.test(n));
    if (!wsName) throw new Error("XLSX package has no worksheet part");
    const ws = parseXml(textDecoder2.decode(byName.get(wsName).data));
    const sheet2 = new Sheet();
    for (const col of descendants(ws, "col")) {
      const min = Number(col.getAttribute("min"));
      const max = Number(col.getAttribute("max"));
      const width = Number(col.getAttribute("width"));
      if (!Number.isFinite(min) || !Number.isFinite(width)) continue;
      for (let c = min; c <= Math.min(max || min, min + 64); c++) {
        sheet2.setColWidth(c - 1, width);
      }
    }
    for (const row of descendants(ws, "row")) {
      if (row.getAttribute("customHeight") !== "1") continue;
      const r = Number(row.getAttribute("r"));
      const ht = Number(row.getAttribute("ht"));
      if (Number.isFinite(r) && Number.isFinite(ht) && r >= 1) sheet2.setRowHeight(r - 1, ht);
    }
    const pendingFormats = [];
    const formulas = [];
    for (const c of descendants(ws, "c")) {
      const addr = c.getAttribute("r");
      if (!addr || !parseAddr(addr)) continue;
      const type = c.getAttribute("t") ?? "n";
      const f = firstChild(c, "f");
      const v = firstChild(c, "v");
      const is = firstChild(c, "is");
      const sAttr = c.getAttribute("s");
      if (sAttr !== null) {
        const info = xfTable[Number(sAttr)];
        if (info) {
          if (Object.keys(info.format).length > 0 && addr) pendingFormats.push([addr, info.format]);
          for (const d of info.dropped) droppedAspects.add(d);
        } else if (Number(sAttr) > 0) {
          droppedAspects.add("unresolved style reference");
        }
      }
      if (f && f.textContent) {
        sheet2.setCell(addr, "=" + f.textContent);
        formulas.push({ addr, storedValue: v?.textContent ?? null, type });
        continue;
      }
      if (type === "s") {
        const idx = Number(v?.textContent ?? "");
        sheet2.setCell(addr, shared[idx] ?? "");
      } else if (type === "inlineStr") {
        sheet2.setCell(addr, descendants(is ?? c, "t").map((t) => t.textContent ?? "").join(""));
      } else if (type === "str") {
        sheet2.setCell(addr, v?.textContent ?? "");
      } else if (type === "b") {
        sheet2.setCell(addr, v?.textContent === "1" ? "TRUE" : "FALSE");
      } else if (type === "e") {
        warnings.push({
          code: "XLSX-IMPORT-ERROR-LITERAL",
          message: `Cell ${addr} held an error literal (${v?.textContent ?? "?"}) with no formula; imported as text.`,
          blockIndex: -1
        });
        sheet2.setCell(addr, v?.textContent ?? "");
      } else if (v?.textContent != null) {
        sheet2.setCell(addr, v.textContent);
      }
    }
    for (const [addr, format] of pendingFormats) sheet2.setFormat(addr, format);
    if (droppedAspects.size > 0) {
      warnings.push({
        code: "XLSX-IMPORT-STYLES",
        message: `Some cell styling could not be represented and was dropped: ${[...droppedAspects].join(", ")}.`,
        blockIndex: -1
      });
    }
    for (const { addr, storedValue, type } of formulas) {
      if (storedValue === null || storedValue === "") continue;
      const ours = sheet2.getCell(addr);
      let match;
      if (isError(ours)) {
        match = type === "e" && ours.code === storedValue;
        if (type !== "e") {
          warnings.push({
            code: "XLSX-IMPORT-FORMULA-UNSUPPORTED",
            message: `Formula in ${addr} (${sheet2.getInput(addr)}) evaluates to ${ours.code} in Casserole; the source stored ${storedValue}. Likely an unsupported function.`,
            blockIndex: -1
          });
          continue;
        }
      } else if (typeof ours === "number") {
        match = Math.abs(ours - Number(storedValue)) <= Math.max(1e-9, Math.abs(ours) * 1e-9);
      } else if (typeof ours === "boolean") {
        match = (ours ? "1" : "0") === storedValue || String(ours).toUpperCase() === storedValue;
      } else {
        match = String(ours ?? "") === storedValue;
      }
      if (!match) {
        warnings.push({
          code: "XLSX-IMPORT-VALUE-MISMATCH",
          message: `Cell ${addr}: Casserole computes ${JSON.stringify(isError(ours) ? ours.code : ours)} but the source file stored ${JSON.stringify(storedValue)}.`,
          blockIndex: -1
        });
      }
    }
    return { sheet: sheet2, report: { format: "xlsx", lossless: warnings.length === 0, warnings } };
  }

  // apps/shared/ribbon.ts
  var CSS = `
#ribbon { background: #f3f1ec; border-bottom: 1px solid #d5d2c8; font-size: 13px; user-select: none; }
#ribbon .rb-tabs { display: flex; gap: 2px; padding: 4px 8px 0; align-items: flex-end; }
#ribbon .rb-tab { border: 1px solid transparent; border-bottom: none; background: none;
  padding: 4px 14px; cursor: pointer; font: inherit; border-radius: 4px 4px 0 0; color: #444; }
#ribbon .rb-tab.active { background: #fbfaf7; border-color: #d5d2c8; color: #1a1a1a; font-weight: 600; }
#ribbon .rb-qat { margin-left: auto; display: flex; gap: 2px; align-items: center; padding-bottom: 2px; }
#ribbon .rb-qat button { font-size: 14px; padding: 2px 8px; }
#ribbon .rb-panel { display: none; background: #fbfaf7; padding: 4px 8px 2px; }
#ribbon .rb-panel.active { display: flex; gap: 4px; align-items: stretch; overflow-x: auto; }
#ribbon .rb-group { display: flex; flex-direction: column; border-right: 1px solid #e2dfd6; padding: 0 8px 0 4px; min-width: 56px; }
#ribbon .rb-group:last-child { border-right: none; }
#ribbon .rb-controls { display: flex; gap: 3px; align-items: center; flex: 1; flex-wrap: wrap; max-height: 64px; align-content: flex-start; }
#ribbon .rb-gname { text-align: center; font-size: 10.5px; color: #8a8578; padding: 1px 0 2px; }
#ribbon .rb-controls button, #ribbon .rb-controls select {
  font: inherit; background: none; border: 1px solid transparent; border-radius: 4px;
  padding: 3px 7px; cursor: pointer; color: #222; }
#ribbon .rb-controls select { background: #fff; border-color: #d5d2c8; max-width: 150px; }
#ribbon .rb-controls button:hover:not(:disabled) { background: #eceade; border-color: #d8d4c4; }
#ribbon .rb-controls button.active { background: #e3e0d0; border-color: #c9c4ae; }
#ribbon .rb-controls button:disabled { color: #b5b0a2; cursor: default; }
#ribbon .rb-big { display: flex; flex-direction: column; align-items: center; min-width: 46px;
  padding: 2px 6px !important; line-height: 1.15; max-height: none; }
#ribbon .rb-big .rb-ico { font-size: 19px; }
#ribbon .rb-big .rb-lbl { font-size: 11px; white-space: pre-line; text-align: center; }
`;
  function makeButton(label, icon, big, title) {
    const b = document.createElement("button");
    if (big) {
      b.className = "rb-big";
      b.innerHTML = `<span class="rb-ico">${icon ?? ""}</span><span class="rb-lbl"></span>`;
      b.querySelector(".rb-lbl").textContent = label;
    } else {
      b.textContent = icon ? `${icon} ${label}` : label;
    }
    if (title) b.title = title;
    return b;
  }
  function buildRibbon(mount, tabs, qatIds = []) {
    if (!document.getElementById("ribbon-css")) {
      const style = document.createElement("style");
      style.id = "ribbon-css";
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    mount.innerHTML = "";
    const tabStrip = document.createElement("div");
    tabStrip.className = "rb-tabs";
    const panels = [];
    tabs.forEach((tab, ti) => {
      const tb = document.createElement("button");
      tb.className = "rb-tab" + (ti === 0 ? " active" : "");
      tb.textContent = tab.name;
      tb.dataset.tab = tab.name;
      tb.addEventListener("click", () => {
        tabStrip.querySelectorAll(".rb-tab").forEach((t) => t.classList.remove("active"));
        panels.forEach((p) => p.classList.remove("active"));
        tb.classList.add("active");
        panels[ti].classList.add("active");
      });
      tabStrip.appendChild(tb);
      const panel = document.createElement("div");
      panel.className = "rb-panel" + (ti === 0 ? " active" : "");
      panel.dataset.panel = tab.name;
      for (const group of tab.groups) {
        const g = document.createElement("div");
        g.className = "rb-group";
        const ctl = document.createElement("div");
        ctl.className = "rb-controls";
        for (const c of group.controls) {
          if (c.kind === "ph") {
            const b = makeButton(c.label, c.icon, c.big, `${c.label} \u2014 not yet implemented in Casserole`);
            b.disabled = true;
            b.dataset.ph = "1";
            ctl.appendChild(b);
          } else if (c.kind === "action") {
            const b = makeButton(c.label, c.icon, c.big, c.title ?? c.label);
            b.addEventListener("click", c.onClick);
            ctl.appendChild(b);
          } else {
            const el = document.getElementById(c.id);
            if (!el) continue;
            if (c.label && el instanceof HTMLButtonElement) {
              if (c.big) {
                el.classList.add("rb-big");
                el.innerHTML = `<span class="rb-ico">${c.icon ?? ""}</span><span class="rb-lbl"></span>`;
                el.querySelector(".rb-lbl").textContent = c.label;
              } else {
                el.textContent = c.icon ? `${c.icon} ${c.label}` : c.label;
              }
            }
            if (c.title) el.title = c.title;
            ctl.appendChild(el);
          }
        }
        const name = document.createElement("div");
        name.className = "rb-gname";
        name.textContent = group.name;
        g.appendChild(ctl);
        g.appendChild(name);
        panel.appendChild(g);
      }
      panels.push(panel);
    });
    const qat = document.createElement("div");
    qat.className = "rb-qat";
    for (const id of qatIds) {
      const el = document.getElementById(id);
      if (el) qat.appendChild(el);
    }
    tabStrip.appendChild(qat);
    mount.appendChild(tabStrip);
    panels.forEach((p) => mount.appendChild(p));
  }

  // apps/sheets/src/main.ts
  var COLS = 12;
  var ROWS = 40;
  var STORAGE_KEY = "casserole-sheets:v1:default";
  var sheet = new Sheet();
  var selected = "A1";
  var selAnchor = "A1";
  var editing = false;
  var dragging = false;
  var clip = null;
  var fillDrag = { src: { r0: 0, c0: 0, r1: 0, c1: 0 }, dest: null };
  var fillActive = false;
  var selAreas = [];
  function allAreas() {
    return [...selAreas, selRect()];
  }
  function inAnyArea(col, row) {
    return allAreas().some((a) => inRect(a, col, row));
  }
  function multiArea() {
    return selAreas.length > 0;
  }
  function eachSelected(fn) {
    const seen = /* @__PURE__ */ new Set();
    for (const a of allAreas()) {
      eachInRect(a, (addr) => {
        if (!seen.has(addr)) {
          seen.add(addr);
          fn(addr);
        }
      });
    }
  }
  function selRect() {
    return normalizeRect(selAnchor, selected);
  }
  function inRect(rect, col, row) {
    return row >= rect.r0 && row <= rect.r1 && col >= rect.c0 && col <= rect.c1;
  }
  function rangeIsMulti() {
    const r = selRect();
    return r.r0 !== r.r1 || r.c0 !== r.c1;
  }
  function eachInRect(rect, fn) {
    for (let r = rect.r0; r <= rect.r1; r++) {
      for (let c = rect.c0; c <= rect.c1; c++) fn(formatAddr({ col: c, row: r }));
    }
  }
  var gridEl = document.getElementById("grid");
  var formulaEl = document.getElementById("formula");
  var addrEl = document.getElementById("addr");
  var statusEl = document.getElementById("status");
  var saveTimer = null;
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ cells: sheet.entries(), cols: sheet.cols(), rows: sheet.rows() }));
      statusEl.textContent = `Saved ${(/* @__PURE__ */ new Date()).toLocaleTimeString()}`;
    } catch {
      statusEl.textContent = "Autosave unavailable \u2014 export CSV to keep your work";
    }
  }
  function scheduleSave() {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(save, 500);
  }
  function restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return seed();
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed) ? parsed : parsed.cells;
      if (!entries || entries.length === 0) return seed();
      for (const e of entries) {
        sheet.setCell(e.addr, e.input);
        if (e.format) sheet.setFormat(e.addr, e.format);
      }
      if (!Array.isArray(parsed) && parsed.cols) {
        for (const c of parsed.cols) sheet.setColWidth(c.col, c.width);
      }
      if (!Array.isArray(parsed) && parsed.rows) {
        for (const r of parsed.rows) sheet.setRowHeight(r.row, r.height);
      }
      statusEl.textContent = "Restored sheet";
    } catch {
      seed();
    }
  }
  function seed() {
    const rows = [
      ["Item", "Qty", "Unit price"],
      ["Paper", "12", "4.5"],
      ["Toner", "2", "89"],
      ["Stapler", "3", "11.25"]
    ];
    rows.forEach((cells, r) => {
      cells.forEach((v, c) => sheet.setCell({ col: c, row: r }, v));
    });
    sheet.setCell("D1", "Line total");
    for (let r = 2; r <= 4; r++) sheet.setCell(`D${r}`, `=B${r}*C${r}`);
    sheet.setCell("A6", "Total");
    sheet.setCell("D6", "=SUM(D2:D4)");
    sheet.setCell("A7", "Average line");
    sheet.setCell("D7", "=ROUND(AVERAGE(D2:D4), 2)");
    sheet.setCell("A8", "Over budget?");
    sheet.setCell("D8", '=IF(D6>300, "YES", "no")');
    for (const a of ["C2", "C3", "C4", "D2", "D3", "D4", "D6", "D7"]) {
      sheet.setFormat(a, { numFmt: "currency" });
    }
    for (const a of ["A1", "B1", "C1", "D1", "A6", "A7", "A8"]) {
      sheet.setFormat(a, { bold: true });
    }
  }
  var CHAR_PX = 7.5;
  var DEFAULT_W = 76;
  function colPx(c) {
    const w = sheet.getColWidth(c);
    return w ? Math.max(34, Math.round(w * CHAR_PX)) : DEFAULT_W;
  }
  var PT_PX = 4 / 3;
  var DEFAULT_ROW_PX = 24;
  function rowPx(r) {
    const h = sheet.getRowHeight(r);
    return h ? Math.max(16, Math.round(h * PT_PX)) : DEFAULT_ROW_PX;
  }
  function applyRowHeights() {
    gridEl.querySelectorAll("th[data-row]").forEach((th) => {
      const h = `${rowPx(Number(th.dataset.row))}px`;
      const tr = th.parentElement;
      tr.style.height = h;
    });
  }
  function applyColWidths() {
    gridEl.querySelectorAll("th[data-col]").forEach((th) => {
      th.style.minWidth = th.style.maxWidth = `${colPx(Number(th.dataset.col))}px`;
    });
    gridEl.querySelectorAll("td[data-addr]").forEach((td) => {
      const c = parseAddr(td.dataset.addr).col;
      td.style.minWidth = td.style.maxWidth = `${colPx(c)}px`;
    });
  }
  function buildGrid() {
    const head = ["<tr><th></th>"];
    for (let c = 0; c < COLS; c++) {
      head.push(`<th data-col="${c}">${colToName(c)}<span class="col-grip" data-grip="${c}"></span></th>`);
    }
    head.push("</tr>");
    const rows = [];
    for (let r = 0; r < ROWS; r++) {
      const cells = [`<th data-row="${r}">${r + 1}<span class="row-grip" data-rowgrip="${r}"></span></th>`];
      for (let c = 0; c < COLS; c++) {
        cells.push(`<td data-addr="${formatAddr({ col: c, row: r })}"></td>`);
      }
      rows.push(`<tr>${cells.join("")}</tr>`);
    }
    gridEl.innerHTML = `<thead>${head.join("")}</thead><tbody>${rows.join("")}</tbody>`;
  }
  function refreshValues() {
    gridEl.querySelectorAll("td[data-addr]").forEach((td) => {
      const addr = td.dataset.addr;
      const value = sheet.getCell(addr);
      const fmt = sheet.getFormat(addr);
      const a = parseAddr(addr);
      td.textContent = sheet.getDisplay(addr);
      td.classList.toggle("error", isError(value));
      td.classList.toggle("num", typeof value === "number");
      td.classList.toggle("selected", addr === selected);
      td.classList.toggle("in-range", (rangeIsMulti() || multiArea()) && inAnyArea(a.col, a.row));
      td.classList.toggle("fill-preview", fillActive && fillDrag.dest !== null && inRect(fillDrag.dest, a.col, a.row));
      td.classList.toggle("bold", fmt.bold === true);
      td.style.textAlign = fmt.align ?? "";
    });
    gridEl.querySelectorAll(".fill-grip").forEach((el) => el.remove());
    const rr = selRect();
    const corner = gridEl.querySelector(
      `td[data-addr="${formatAddr({ col: rr.c1, row: rr.r1 })}"]`
    );
    if (corner && !editing && !multiArea()) {
      const grip = document.createElement("span");
      grip.className = "fill-grip";
      corner.appendChild(grip);
    }
    applyColWidths();
    applyRowHeights();
    const r = selRect();
    addrEl.textContent = multiArea() ? `${allAreas().length} areas` : rangeIsMulti() ? `${formatAddr({ col: r.c0, row: r.r0 })}:${formatAddr({ col: r.c1, row: r.r1 })}` : selected;
    if (!editing) formulaEl.value = sheet.getInput(selected);
    syncFormatToolbar();
  }
  function syncFormatToolbar() {
    const fmt = sheet.getFormat(selected);
    document.getElementById("btn-bold")?.classList.toggle("active", fmt.bold === true);
    const numSel = document.getElementById("fmt-num");
    if (numSel) numSel.value = fmt.numFmt ?? "general";
    const alignSel = document.getElementById("fmt-align");
    if (alignSel) alignSel.value = fmt.align ?? "auto";
  }
  document.getElementById("btn-bold")?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const turnOn = !sheet.getFormat(selected).bold;
    eachSelected((addr) => sheet.setFormat(addr, { bold: turnOn ? true : null }));
    refreshValues();
    scheduleSave();
  });
  document.getElementById("fmt-num")?.addEventListener("change", (e) => {
    const v = e.target.value;
    eachSelected((addr) => sheet.setFormat(addr, { numFmt: v }));
    refreshValues();
    scheduleSave();
    formulaEl.focus();
  });
  document.getElementById("fmt-align")?.addEventListener("change", (e) => {
    const v = e.target.value;
    eachSelected((addr) => sheet.setFormat(addr, { align: v === "auto" ? null : v }));
    refreshValues();
    scheduleSave();
    formulaEl.focus();
  });
  function select(addr, extend = false, addArea = false) {
    if (addArea) {
      selAreas.push(selRect());
    } else if (!extend) {
      selAreas = [];
    }
    selected = addr;
    if (!extend) selAnchor = addr;
    editing = false;
    refreshValues();
  }
  function commit(input, move) {
    sheet.setCell(selected, input);
    editing = false;
    const a = parseAddr(selected);
    if (move === "down" && a.row < ROWS - 1) selected = formatAddr({ col: a.col, row: a.row + 1 });
    if (move === "right" && a.col < COLS - 1) selected = formatAddr({ col: a.col + 1, row: a.row });
    refreshValues();
    scheduleSave();
  }
  gridEl.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("fill-grip")) {
      fillActive = true;
      fillDrag = { src: selRect(), dest: null };
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const td = e.target.closest("td[data-addr]");
    if (!td) return;
    select(td.dataset.addr, e.shiftKey, (e.ctrlKey || e.metaKey) && !e.shiftKey);
    dragging = true;
    e.preventDefault();
  });
  gridEl.addEventListener("pointerover", (e) => {
    const td = e.target.closest("td[data-addr]");
    if (fillActive) {
      if (!td) return;
      const a = parseAddr(td.dataset.addr);
      const src = fillDrag.src;
      if (a.row > src.r1) {
        fillDrag.dest = { r0: src.r1 + 1, c0: src.c0, r1: a.row, c1: src.c1 };
      } else if (a.col > src.c1) {
        fillDrag.dest = { r0: src.r0, c0: src.c1 + 1, r1: src.r1, c1: a.col };
      } else {
        fillDrag.dest = null;
      }
      refreshValues();
      return;
    }
    if (!dragging) return;
    if (td && td.dataset.addr !== selected) select(td.dataset.addr, true);
  });
  document.addEventListener("pointerup", () => {
    if (fillActive) {
      fillActive = false;
      if (fillDrag.dest) {
        fillRange(sheet, fillDrag.src, fillDrag.dest);
        selAnchor = formatAddr({ col: fillDrag.src.c0, row: fillDrag.src.r0 });
        selected = formatAddr({ col: fillDrag.dest.c1, row: fillDrag.dest.r1 });
        statusEl.textContent = "Filled";
        scheduleSave();
      }
      fillDrag.dest = null;
      refreshValues();
      formulaEl.focus();
      return;
    }
    if (dragging) {
      dragging = false;
      formulaEl.focus();
      formulaEl.select();
    }
  });
  formulaEl.addEventListener("input", () => {
    editing = true;
  });
  formulaEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(formulaEl.value, "down");
      formulaEl.focus();
    } else if (e.key === "Tab") {
      e.preventDefault();
      commit(formulaEl.value, "right");
      formulaEl.focus();
    } else if (e.key === "Escape") {
      editing = false;
      refreshValues();
    } else if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key) && !editing) {
      const a = parseAddr(selected);
      if (e.key === "ArrowDown" && a.row < ROWS - 1) a.row++;
      if (e.key === "ArrowUp" && a.row > 0) a.row--;
      if (e.key === "ArrowRight" && a.col < COLS - 1) a.col++;
      if (e.key === "ArrowLeft" && a.col > 0) a.col--;
      e.preventDefault();
      select(formatAddr(a), e.shiftKey);
    } else if ((e.key === "Delete" || e.key === "Backspace") && !editing && (rangeIsMulti() || multiArea())) {
      e.preventDefault();
      for (const area of allAreas()) clearRange(sheet, area);
      refreshValues();
      scheduleSave();
    } else if ((e.ctrlKey || e.metaKey) && !editing && ["c", "x", "v"].includes(e.key.toLowerCase())) {
      const k = e.key.toLowerCase();
      e.preventDefault();
      if ((k === "c" || k === "x") && multiArea()) {
        statusEl.textContent = "Can't copy a multi-area selection";
        return;
      }
      if (k === "c" || k === "x") {
        clip = copyRange(sheet, selRect());
        try {
          void navigator.clipboard?.writeText(rangeToTSV(sheet, selRect()));
        } catch {
        }
        if (k === "x") {
          clearRange(sheet, selRect());
          scheduleSave();
        }
        statusEl.textContent = `${k === "x" ? "Cut" : "Copied"} ${clip.rows}\xD7${clip.cols}`;
        refreshValues();
      } else {
        if (clip) {
          pasteClip(sheet, clip, formatAddr({ col: selRect().c0, row: selRect().r0 }));
          refreshValues();
          scheduleSave();
          statusEl.textContent = "Pasted (formulas rebased)";
        } else if (navigator.clipboard?.readText) {
          navigator.clipboard.readText().then((text) => {
            if (!text) return;
            pasteTSV(sheet, text, formatAddr({ col: selRect().c0, row: selRect().r0 }));
            refreshValues();
            scheduleSave();
            statusEl.textContent = "Pasted values from clipboard";
          }).catch(() => {
            statusEl.textContent = "Clipboard read unavailable here";
          });
        }
      }
    }
  });
  var gripDrag = null;
  var rowGripDrag = null;
  gridEl.addEventListener("pointerdown", (e) => {
    const rowGrip = e.target.closest(".row-grip");
    if (rowGrip) {
      e.preventDefault();
      e.stopPropagation();
      const row = Number(rowGrip.dataset.rowgrip);
      rowGripDrag = { row, startY: e.clientY, startPx: rowPx(row) };
      return;
    }
    const grip = e.target.closest(".col-grip");
    if (!grip) return;
    e.preventDefault();
    e.stopPropagation();
    const col = Number(grip.dataset.grip);
    gripDrag = { col, startX: e.clientX, startPx: colPx(col) };
  });
  document.addEventListener("pointermove", (e) => {
    if (rowGripDrag) {
      const px2 = Math.max(16, rowGripDrag.startPx + (e.clientY - rowGripDrag.startY));
      sheet.setRowHeight(rowGripDrag.row, px2 / PT_PX);
      applyRowHeights();
      return;
    }
    if (!gripDrag) return;
    const px = Math.max(34, gripDrag.startPx + (e.clientX - gripDrag.startX));
    sheet.setColWidth(gripDrag.col, px / CHAR_PX);
    applyColWidths();
  });
  document.addEventListener("pointerup", () => {
    if (rowGripDrag) {
      rowGripDrag = null;
      scheduleSave();
    }
    if (gripDrag) {
      gripDrag = null;
      scheduleSave();
    }
  });
  var hostDownloads = null;
  if (window.claude?.use) {
    window.claude.use("downloads").then((d) => {
      hostDownloads = d;
    }).catch(() => {
    });
  }
  function csvEscape(text) {
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
  document.getElementById("btn-export-csv")?.addEventListener("click", async () => {
    let maxRow = 0;
    let maxCol = 0;
    for (const { addr } of sheet.entries()) {
      const a2 = parseAddr(addr);
      maxRow = Math.max(maxRow, a2.row);
      maxCol = Math.max(maxCol, a2.col);
    }
    const lines = [];
    for (let r = 0; r <= maxRow; r++) {
      const cells = [];
      for (let c = 0; c <= maxCol; c++) {
        cells.push(csvEscape(sheet.getDisplay(formatAddr({ col: c, row: r }))));
      }
      lines.push(cells.join(","));
    }
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv" });
    if (hostDownloads) {
      try {
        await hostDownloads.save({ filename: "sheet.csv", data: blob });
        return;
      } catch {
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sheet.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  async function deliverBlob(filename, blob) {
    if (hostDownloads) {
      try {
        await hostDownloads.save({ filename, data: blob });
        return;
      } catch {
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  document.getElementById("btn-export-xlsx")?.addEventListener("click", async () => {
    try {
      const { bytes } = await exportXlsx(sheet);
      await deliverBlob(
        "sheet.xlsx",
        new Blob([bytes], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        })
      );
    } catch (err2) {
      statusEl.textContent = `\u26A0 XLSX export failed: ${err2 instanceof Error ? err2.message : String(err2)}`;
    }
  });
  document.getElementById("btn-open")?.addEventListener("click", () => {
    document.getElementById("file-open")?.click();
  });
  document.getElementById("file-open")?.addEventListener("change", async (e) => {
    const input = e.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const { sheet: imported, report } = await importXlsx(new Uint8Array(await file.arrayBuffer()));
      sheet = imported;
      selected = "A1";
      refreshValues();
      scheduleSave();
      if (report.lossless) {
        statusEl.textContent = "Imported XLSX \u2014 no loss detected for this workbook";
      } else {
        statusEl.textContent = `Imported XLSX with ${report.warnings.length} note(s)`;
        window.alert(
          "Import loss report:\n\n" + [...new Set(report.warnings.map((w) => `\u2022 ${w.message}`))].join("\n")
        );
      }
    } catch (err2) {
      statusEl.textContent = `\u26A0 Import failed: ${err2 instanceof Error ? err2.message : String(err2)}`;
    }
  });
  document.getElementById("btn-clear")?.addEventListener("click", () => {
    if (!window.confirm("Clear the whole sheet? This cannot be undone.")) return;
    sheet = new Sheet();
    refreshValues();
    scheduleSave();
  });
  buildGrid();
  restore();
  refreshValues();
  formulaEl.focus();
  function sendClipKey(key) {
    formulaEl.dispatchEvent(
      new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true })
    );
  }
  buildRibbon(
    document.getElementById("ribbon"),
    [
      {
        name: "Home",
        groups: [
          {
            name: "Clipboard",
            controls: [
              { kind: "action", label: "Paste", icon: "\u{1F4CB}", big: true, title: "Paste (Ctrl/Cmd-V)", onClick: () => sendClipKey("v") },
              { kind: "action", label: "Cut", icon: "\u2702", title: "Cut (Ctrl/Cmd-X)", onClick: () => sendClipKey("x") },
              { kind: "action", label: "Copy", icon: "\u2FFB", title: "Copy (Ctrl/Cmd-C)", onClick: () => sendClipKey("c") },
              { kind: "ph", label: "Format Painter", icon: "\u{1F58C}" }
            ]
          },
          {
            name: "Font",
            controls: [
              { kind: "ph", label: "Calibri" },
              { kind: "ph", label: "11" },
              { kind: "move", id: "btn-bold" },
              { kind: "ph", label: "I" },
              { kind: "ph", label: "U" },
              { kind: "ph", label: "Borders", icon: "\u229E" },
              { kind: "ph", label: "Fill Color", icon: "\u{1FAA3}" },
              { kind: "ph", label: "Font Color", icon: "A" }
            ]
          },
          {
            name: "Alignment",
            controls: [
              { kind: "move", id: "fmt-align" },
              { kind: "ph", label: "Wrap Text" },
              { kind: "ph", label: "Merge & Center" }
            ]
          },
          {
            name: "Number",
            controls: [
              { kind: "move", id: "fmt-num" },
              { kind: "ph", label: ",", icon: "" },
              { kind: "ph", label: ".00\u2192.0" },
              { kind: "ph", label: ".0\u2192.00" }
            ]
          },
          {
            name: "Cells",
            controls: [
              { kind: "ph", label: "Insert", icon: "\u2295" },
              { kind: "ph", label: "Delete", icon: "\u2296" },
              { kind: "ph", label: "Format", icon: "\u25A4" }
            ]
          },
          {
            name: "Editing",
            controls: [
              { kind: "action", label: "AutoSum", icon: "\u03A3", title: "Start a =SUM( formula in the formula bar", onClick: () => {
                formulaEl.value = "=SUM(";
                formulaEl.dispatchEvent(new Event("input", { bubbles: true }));
                formulaEl.focus();
              } },
              { kind: "move", id: "btn-clear", label: "Clear" },
              { kind: "action", label: "Sort A\u2192Z", icon: "\u21E9", title: "Sort the selected range by its first column, ascending", onClick: () => {
                if (!rangeIsMulti()) {
                  statusEl.textContent = "Select a range to sort";
                  return;
                }
                sortRange(sheet, selRect());
                refreshValues();
                scheduleSave();
                statusEl.textContent = "Sorted A\u2192Z";
              } },
              { kind: "action", label: "Sort Z\u2192A", icon: "\u21E7", title: "Sort the selected range by its first column, descending", onClick: () => {
                if (!rangeIsMulti()) {
                  statusEl.textContent = "Select a range to sort";
                  return;
                }
                sortRange(sheet, selRect(), true);
                refreshValues();
                scheduleSave();
                statusEl.textContent = "Sorted Z\u2192A";
              } },
              { kind: "ph", label: "Filter", icon: "\u23F7" },
              { kind: "ph", label: "Find & Select", icon: "\u{1F50D}" }
            ]
          }
        ]
      },
      {
        name: "Insert",
        groups: [
          { name: "Tables", controls: [{ kind: "ph", label: "PivotTable", big: true, icon: "\u25A6" }, { kind: "ph", label: "Table", big: true, icon: "\u229E" }] },
          { name: "Charts", controls: [{ kind: "ph", label: "Recommended\nCharts", big: true, icon: "\u{1F4CA}" }, { kind: "ph", label: "Column" }, { kind: "ph", label: "Line" }, { kind: "ph", label: "Pie" }] },
          { name: "Sparklines", controls: [{ kind: "ph", label: "Line" }, { kind: "ph", label: "Column" }] }
        ]
      },
      {
        name: "Formulas",
        groups: [
          {
            name: "Function Library",
            controls: [
              { kind: "action", label: "Insert\nFunction", big: true, icon: "\u0192x", title: "Start a formula in the formula bar", onClick: () => {
                formulaEl.value = "=";
                formulaEl.dispatchEvent(new Event("input", { bubbles: true }));
                formulaEl.focus();
              } },
              { kind: "ph", label: "Financial" },
              { kind: "ph", label: "Logical" },
              { kind: "ph", label: "Text" },
              { kind: "ph", label: "Date & Time" },
              { kind: "ph", label: "Lookup" }
            ]
          },
          { name: "Calculation", controls: [{ kind: "ph", label: "Calculate Now" }] }
        ]
      },
      {
        name: "File",
        groups: [
          { name: "Workbook", controls: [{ kind: "move", id: "btn-open", label: "Open", icon: "\u{1F4C2}", big: true }] },
          {
            name: "Export",
            controls: [
              { kind: "move", id: "btn-export-xlsx", label: "Excel\n(.xlsx)", icon: "\u2B07", big: true },
              { kind: "move", id: "btn-export-csv", label: "CSV", icon: "\u2B07", big: true }
            ]
          }
        ]
      }
    ],
    []
  );
})();
