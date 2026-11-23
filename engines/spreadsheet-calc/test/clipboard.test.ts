import { strict as assert } from "node:assert";
import test from "node:test";
import { Sheet } from "../src/engine";
import {
  copyRange,
  clearRange,
  normalizeRect,
  pasteClip,
  pasteTSV,
  rangeToTSV,
  shiftFormula,
} from "../src/clipboard";
import { isError } from "../src/types";

test("shiftFormula: relative refs move, $ anchors pin, functions untouched", () => {
  assert.equal(shiftFormula("A1+B2", 1, 1), "B2+C3");
  assert.equal(shiftFormula("$A$1+A$1+$A1+A1", 2, 3), "$A$1+D$1+$A3+D3");
  assert.equal(shiftFormula("SUM(A1:B3)*LOG10(C1)", 1, 0), "SUM(A2:B4)*LOG10(C2)");
  assert.equal(shiftFormula('IF(A1>0, "A1 stays in text", B1)', 0, 1), 'IF(B1>0, "A1 stays in text", C1)');
  assert.equal(shiftFormula("A1", -1, 0), "#REF!", "shift above row 1");
  assert.equal(shiftFormula("B2-A1", 0, -1), "A2-#REF!");
  assert.equal(shiftFormula("1+", 1, 1), "1+", "unparsable input left alone");
});

test("copy/paste rebases formulas like Excel; formats travel", () => {
  const s = new Sheet();
  s.setCell("A1", "10");
  s.setCell("A2", "20");
  s.setCell("B1", "=A1*2");
  s.setCell("B2", "=SUM($A$1:A2)");
  s.setFormat("B1", { bold: true, numFmt: "currency" });

  const clip = copyRange(s, normalizeRect("B1", "B2"));
  const rect = pasteClip(s, clip, "D5");
  assert.deepEqual(rect, { r0: 4, c0: 3, r1: 5, c1: 3 });
  assert.equal(s.getInput("D5"), "=C5*2", "relative ref shifted");
  assert.equal(s.getInput("D6"), "=SUM($A$1:C6)", "anchor pinned, relative end shifted");
  assert.deepEqual(s.getFormat("D5"), { bold: true, numFmt: "currency" });
  // values recompute at the new location (C5/C6 empty → 0 / anchored sum)
  assert.equal(s.getCell("D5"), 0);
});

test("paste overwrites the destination footprint, including stale cells", () => {
  const s = new Sheet();
  s.setCell("A1", "x");
  s.setCell("C1", "stale");
  s.setCell("C2", "stale2");
  const clip = copyRange(s, normalizeRect("A1", "A2")); // A2 empty
  pasteClip(s, clip, "C1");
  assert.equal(s.getCell("C1"), "x");
  assert.equal(s.getCell("C2"), null, "empty source cell clears the stale target");
});

test("clearRange empties inputs but keeps formats", () => {
  const s = new Sheet();
  s.setCell("A1", "5");
  s.setFormat("A1", { bold: true });
  clearRange(s, normalizeRect("A1", "B2"));
  assert.equal(s.getCell("A1"), null);
  assert.deepEqual(s.getFormat("A1"), { bold: true });
});

test("TSV out carries display values; TSV in pastes literals", () => {
  const s = new Sheet();
  s.setCell("A1", "1234.5");
  s.setFormat("A1", { numFmt: "currency" });
  s.setCell("B1", "=A1*2");
  assert.equal(rangeToTSV(s, normalizeRect("A1", "B1")), "$1,234.50\t2469");

  const t = new Sheet();
  const rect = pasteTSV(t, "a\tb\n1\t=nope\n", "B2");
  assert.deepEqual(rect, { r0: 1, c0: 1, r1: 2, c1: 2 });
  assert.equal(t.getCell("B2"), "a");
  assert.equal(t.getCell("B3"), 1);
  const c3 = t.getCell("C3");
  assert.ok(isError(c3), "pasted formula text evaluates (and may error) like typed input");
});

// ---------- fill handle (WO-33) ----------
import { fillRange } from "../src/clipboard";

test("fill: arithmetic series continue; single values copy; patterns cycle", () => {
  const s = new Sheet();
  s.setCell("A1", "10");
  s.setCell("A2", "20");
  fillRange(s, { r0: 0, c0: 0, r1: 1, c1: 0 }, { r0: 2, c0: 0, r1: 4, c1: 0 });
  assert.deepEqual(["A3", "A4", "A5"].map((a) => s.getCell(a)), [30, 40, 50], "series continues");

  s.setCell("B1", "hello");
  fillRange(s, { r0: 0, c0: 1, r1: 0, c1: 1 }, { r0: 1, c0: 1, r1: 2, c1: 1 });
  assert.deepEqual(["B2", "B3"].map((a) => s.getCell(a)), ["hello", "hello"], "single value copies");

  s.setCell("C1", "x");
  s.setCell("C2", "y");
  s.setCell("C3", "1"); // mixed → cycle, not series
  fillRange(s, { r0: 0, c0: 2, r1: 2, c1: 2 }, { r0: 3, c0: 2, r1: 5, c1: 2 });
  assert.deepEqual(["C4", "C5", "C6"].map((a) => s.getCell(a)), ["x", "y", 1], "pattern cycles");
});

test("fill: formulas shift relative refs down the lane; formats travel; fill-right works", () => {
  const s = new Sheet();
  s.setCell("A1", "1");
  s.setCell("A2", "2");
  s.setCell("A3", "3");
  s.setCell("B1", "=A1*10");
  s.setFormat("B1", { numFmt: "currency" });
  fillRange(s, { r0: 0, c0: 1, r1: 0, c1: 1 }, { r0: 1, c0: 1, r1: 2, c1: 1 });
  assert.equal(s.getInput("B3"), "=A3*10");
  assert.equal(s.getCell("B3"), 30);
  assert.deepEqual(s.getFormat("B2"), { numFmt: "currency" });

  // fill right from two columns of numbers → series per row
  s.setCell("D1", "5");
  s.setCell("E1", "10");
  fillRange(s, { r0: 0, c0: 3, r1: 0, c1: 4 }, { r0: 0, c0: 5, r1: 0, c1: 7 });
  assert.deepEqual(["F1", "G1", "H1"].map((a) => s.getCell(a)), [15, 20, 25]);
});

// ---------- range sort (WO-41) ----------
import { sortRange } from "../src/clipboard";

test("sort: numbers before text, empties last, rows move whole, formulas rebase, formats travel", () => {
  const s = new Sheet();
  // A: key, B: data, C: formula on same row
  s.setCell("A1", "banana"); s.setCell("B1", "10"); s.setCell("C1", "=B1*2");
  s.setCell("A2", "3");      s.setCell("B2", "20"); s.setCell("C2", "=B2*2");
  s.setCell("A3", "");       s.setCell("B3", "30");
  s.setCell("A4", "Apple");  s.setCell("B4", "40"); s.setCell("C4", "=B4*2");
  s.setCell("A5", "1");      s.setCell("B5", "50"); s.setCell("C5", "=B5*2");
  s.setFormat("B5", { bold: true });
  sortRange(s, { r0: 0, c0: 0, r1: 4, c1: 2 });
  // expected order: 1, 3 (numbers), Apple, banana (case-insensitive text), empty
  assert.deepEqual(["A1","A2","A3","A4","A5"].map((a) => s.getCell(a)), [1, 3, "Apple", "banana", null]);
  assert.deepEqual(["B1","B2","B3","B4","B5"].map((a) => s.getCell(a)), [50, 20, 40, 10, 30], "rows moved whole");
  assert.equal(s.getInput("C1"), "=B1*2", "formula rebased to its new row");
  assert.equal(s.getCell("C1"), 100);
  assert.deepEqual(s.getFormat("B1"), { bold: true }, "format traveled with its row");
  assert.deepEqual(s.getFormat("B5"), {}, "old format location cleared");
  // descending keeps empties last
  sortRange(s, { r0: 0, c0: 0, r1: 4, c1: 2 }, true);
  assert.deepEqual(["A1","A2","A3","A4","A5"].map((a) => s.getCell(a)), ["banana", "Apple", 3, 1, null]);
});
