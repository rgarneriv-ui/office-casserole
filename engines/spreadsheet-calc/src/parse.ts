/**
 * Formula tokenizer and parser (spec §7.2: tokenizer, parser, AST).
 * Grammar (precedence low → high):
 *   compare:  = <> < <= > >=
 *   concat:   &
 *   addsub:   + -
 *   muldiv:   * /
 *   power:    ^            (right-associative)
 *   unary:    - +
 *   primary:  number | string | TRUE/FALSE | ref | range | FUNC(args) | (expr)
 */

import { parseAddr } from "./addr";
import { Ast } from "./types";

export class FormulaError extends Error {}

interface Token {
  kind: "num" | "str" | "ident" | "op";
  text: string;
  pos: number;
}

const OPS = ["<>", "<=", ">=", "=", "<", ">", "+", "-", "*", "/", "^", "&", "(", ")", ",", ":"];

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t" || ch === "\n") {
      i++;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      const m = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i))!;
      tokens.push({ kind: "num", text: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (ch === ".") {
      const m = /^\.[0-9]+([eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (m) {
        tokens.push({ kind: "num", text: m[0], pos: i });
        i += m[0].length;
        continue;
      }
      throw new FormulaError(`Unexpected '.' at ${i}`);
    }
    if (ch === '"') {
      let j = i + 1;
      let out = "";
      for (;;) {
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

export function parseFormula(src: string): Ast {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = (): Token | null => tokens[pos] ?? null;
  const take = (): Token => {
    const t = tokens[pos];
    if (!t) throw new FormulaError("Unexpected end of formula");
    pos++;
    return t;
  };
  const takeOp = (text: string): void => {
    const t = take();
    if (t.kind !== "op" || t.text !== text) {
      throw new FormulaError(`Expected '${text}' at ${t.pos}`);
    }
  };

  function primary(): Ast {
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
        const args: Ast[] = [];
        if (!(peek()?.kind === "op" && peek()?.text === ")")) {
          for (;;) {
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

  function unary(): Ast {
    const t = peek();
    if (t && t.kind === "op" && (t.text === "-" || t.text === "+")) {
      take();
      return { t: "un", op: t.text as "-" | "+", v: unary() };
    }
    return primary();
  }

  function power(): Ast {
    const base = unary();
    const t = peek();
    if (t && t.kind === "op" && t.text === "^") {
      take();
      return { t: "bin", op: "^", l: base, r: power() }; // right-assoc
    }
    return base;
  }

  const binLevel =
    (ops: string[], next: () => Ast) =>
    (): Ast => {
      let left = next();
      for (;;) {
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
    throw new FormulaError(`Unexpected trailing input at ${tokens[pos]!.pos}`);
  }
  return ast;
}
