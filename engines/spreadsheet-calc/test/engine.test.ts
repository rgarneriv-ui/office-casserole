import { strict as assert } from "node:assert";
import test from "node:test";
import { Sheet } from "../src/engine";
// ---------- row heights (WO-36) ----------
test("row heights: set/get/clear, capped, listed sorted", () => {
  const s = new Sheet();
  assert.equal(s.getRowHeight(3), undefined);
  s.setRowHeight(3, 42);
  s.setRowHeight(1, 24.567);
  assert.equal(s.getRowHeight(3), 42);
  assert.equal(s.getRowHeight(1), 24.57, "rounded to 2 decimals");
  s.setRowHeight(5, 9999);
  assert.equal(s.getRowHeight(5), 300, "capped");
  assert.deepEqual(s.rows().map((r) => r.row), [1, 3, 5], "sorted");
  s.setRowHeight(3, null);
  assert.equal(s.getRowHeight(3), undefined, "cleared");
});
