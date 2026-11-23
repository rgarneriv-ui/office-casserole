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
