import { strict as assert } from "node:assert";
import test from "node:test";
import { Sheet } from "../src/engine";
import { parseAddr, formatAddr, colToName, nameToCol } from "../src/addr";
import { isError } from "../src/types";

test("address arithmetic: A, Z, AA, AB round-trip", () => {
  assert.equal(colToName(0), "A");
  assert.equal(colToName(25), "Z");
  assert.equal(colToName(26), "AA");
  assert.equal(nameToCol("AB"), 27);
  assert.deepEqual(parseAddr("B12"), { col: 1, row: 11 });
  assert.equal(formatAddr({ col: 27, row: 11 }), "AB12");
  assert.equal(parseAddr("B0"), null);
});

test("literals: numbers, text, booleans, percent", () => {
  const s = new Sheet();
  s.setCell("A1", "42");
  s.setCell("A2", "hello");
  s.setCell("A3", "TRUE");
  s.setCell("A4", "12.5%");
  s.setCell("A5", "3e2");
  assert.equal(s.getCell("A1"), 42);
  assert.equal(s.getCell("A2"), "hello");
  assert.equal(s.getCell("A3"), true);
  assert.equal(s.getCell("A4"), 0.125);
  assert.equal(s.getCell("A5"), 300);
});

test("operator precedence and associativity", () => {
  const s = new Sheet();
  s.setCell("A1", "=2+3*4");
  s.setCell("A2", "=(2+3)*4");
  s.setCell("A3", "=2^3^2"); // right-assoc → 512
  s.setCell("A4", "=-3^2"); // unary binds the operand → (-3)^2 = 9 (Excel convention)
  s.setCell("A5", '="a"&"b"&1');
  s.setCell("A6", "=1+2=3");
  assert.equal(s.getCell("A1"), 14);
  assert.equal(s.getCell("A2"), 20);
  assert.equal(s.getCell("A3"), 512);
  assert.equal(s.getCell("A4"), 9);
  assert.equal(s.getCell("A5"), "ab1");
  assert.equal(s.getCell("A6"), true);
});

test("references and ranges through functions", () => {
  const s = new Sheet();
  s.setCell("A1", "10");
  s.setCell("A2", "20");
  s.setCell("A3", "30");
  s.setCell("B1", "=SUM(A1:A3)");
  s.setCell("B2", "=AVERAGE(A1:A3)");
  s.setCell("B3", "=SUM(A1:A3, 40)");
  s.setCell("B4", "=COUNT(A1:A4)"); // A4 empty
  assert.equal(s.getCell("B1"), 60);
  assert.equal(s.getCell("B2"), 20);
  assert.equal(s.getCell("B3"), 100);
  assert.equal(s.getCell("B4"), 3);
});

test("recalculation ripples through dependents", () => {
  const s = new Sheet();
  s.setCell("A1", "1");
  s.setCell("B1", "=A1*2");
  s.setCell("C1", "=B1+1");
  assert.equal(s.getCell("C1"), 3);
  s.setCell("A1", "10");
  assert.equal(s.getCell("B1"), 20);
  assert.equal(s.getCell("C1"), 21);
});

test("recalculation is incremental: unrelated formulas are not re-evaluated", () => {
  const s = new Sheet();
  s.setCell("A1", "1");
  s.setCell("B1", "=A1+1");
  s.setCell("C1", "=B1+1");
  s.setCell("Z9", "=SUM(1,2,3)"); // unrelated
  const before = s.evalCount;
  s.setCell("A1", "5");
  const evals = s.evalCount - before;
  assert.equal(evals, 2, `expected only B1 and C1 to re-evaluate, got ${evals}`);
  assert.equal(s.getCell("C1"), 7);
});

test("errors: DIV/0, NAME?, VALUE!, PARSE! — and propagation", () => {
  const s = new Sheet();
  s.setCell("A1", "=1/0");
  s.setCell("A2", "=NOSUCHFN(1)");
  s.setCell("A3", '="abc"+1');
  s.setCell("A4", "=1+");
  s.setCell("B1", "=A1+1"); // error propagates
  const codes = (r: string) => {
    const v = s.getCell(r);
    return isError(v) ? v.code : v;
  };
  assert.equal(codes("A1"), "#DIV/0!");
  assert.equal(codes("A2"), "#NAME?");
  assert.equal(codes("A3"), "#VALUE!");
  assert.equal(codes("A4"), "#PARSE!");
  assert.equal(codes("B1"), "#DIV/0!");
  assert.equal(s.getDisplay("A1"), "#DIV/0!");
});

test("circular references are detected, flagged, and recoverable", () => {
  const s = new Sheet();
  s.setCell("A1", "=B1+1");
  s.setCell("B1", "=A1+1");
  const a = s.getCell("A1");
  const b = s.getCell("B1");
  assert.ok(isError(a) && a.code === "#CYCLE!", "A1 flagged");
  assert.ok(isError(b) && b.code === "#CYCLE!", "B1 flagged");
  // breaking the cycle recovers both cells
  s.setCell("B1", "5");
  assert.equal(s.getCell("A1"), 6);
});

test("self-reference is a cycle", () => {
  const s = new Sheet();
  s.setCell("A1", "=A1+1");
  const v = s.getCell("A1");
  assert.ok(isError(v) && v.code === "#CYCLE!");
});

test("IF / AND / OR / NOT, text and numeric functions", () => {
  const s = new Sheet();
  s.setCell("A1", "85");
  s.setCell("B1", '=IF(A1>=90, "A", IF(A1>=80, "B", "C"))');
  s.setCell("B2", "=AND(A1>50, A1<100)");
  s.setCell("B3", "=OR(A1>100, FALSE)");
  s.setCell("B4", "=NOT(TRUE)");
  s.setCell("B5", "=ROUND(2.567, 2)");
  s.setCell("B6", "=ABS(-4)+SQRT(9)");
  s.setCell("B7", '=UPPER(CONCAT("ab", "cd"))');
  s.setCell("B8", '=LEN("hello")');
  s.setCell("B9", "=SQRT(-1)");
  assert.equal(s.getCell("B1"), "B");
  assert.equal(s.getCell("B2"), true);
  assert.equal(s.getCell("B3"), false);
  assert.equal(s.getCell("B4"), false);
  assert.equal(s.getCell("B5"), 2.57);
  assert.equal(s.getCell("B6"), 7);
  assert.equal(s.getCell("B7"), "ABCD");
  assert.equal(s.getCell("B8"), 5);
  const b9 = s.getCell("B9");
  assert.ok(isError(b9) && b9.code === "#NUM!");
});

test("empty cells: 0 in arithmetic, skipped in aggregates", () => {
  const s = new Sheet();
  s.setCell("B1", "=A1+5"); // A1 empty
  s.setCell("B2", "=AVERAGE(A1:A3)"); // all empty
  assert.equal(s.getCell("B1"), 5);
  const b2 = s.getCell("B2");
  assert.ok(isError(b2) && b2.code === "#DIV/0!");
});

test("formulas can be entered before their inputs exist (forward references)", () => {
  const s = new Sheet();
  s.setCell("B1", "=SUM(A1:A2)");
  assert.equal(s.getCell("B1"), 0);
  s.setCell("A1", "7");
  s.setCell("A2", "3");
  assert.equal(s.getCell("B1"), 10);
});

test("entries() round-trips a sheet through persistence", () => {
  const s = new Sheet();
  s.setCell("A1", "5");
  s.setCell("B2", "=A1*3");
  const saved = s.entries();
  const restored = new Sheet();
  for (const { addr, input } of saved) restored.setCell(addr, input);
  assert.equal(restored.getCell("B2"), 15);
  assert.equal(restored.getInput("B2"), "=A1*3");
});

test("string comparison is case-insensitive; text sorts above numbers", () => {
  const s = new Sheet();
  s.setCell("A1", '="Apple"="APPLE"');
  s.setCell("A2", '="text">999');
  assert.equal(s.getCell("A1"), true);
  assert.equal(s.getCell("A2"), true);
});
