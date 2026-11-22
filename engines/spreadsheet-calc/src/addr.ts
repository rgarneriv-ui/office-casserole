import { Addr } from "./types";

export function colToName(col: number): string {
  let name = "";
  let c = col;
  for (;;) {
    name = String.fromCharCode(65 + (c % 26)) + name;
    c = Math.floor(c / 26) - 1;
    if (c < 0) break;
  }
  return name;
}

export function nameToCol(name: string): number {
  let col = 0;
  for (const ch of name.toUpperCase()) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return col - 1;
}

const ADDR_RE = /^\$?([A-Za-z]{1,3})\$?([0-9]+)$/;

export function parseAddr(text: string): Addr | null {
  const m = ADDR_RE.exec(text);
  if (!m) return null;
  const row = parseInt(m[2]!, 10) - 1;
  if (row < 0) return null;
  return { col: nameToCol(m[1]!), row };
}

export function formatAddr(addr: Addr): string {
  return `${colToName(addr.col)}${addr.row + 1}`;
}

export function addrKey(addr: Addr): string {
  return `${addr.col}:${addr.row}`;
}

/** Normalized iteration order over a rectangular range. */
export function* rangeAddrs(from: Addr, to: Addr): Generator<Addr> {
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
