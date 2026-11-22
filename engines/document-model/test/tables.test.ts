import { strict as assert } from "node:assert";
import test from "node:test";
import { newBlock, validateModel, docText } from "../src/model";
import {
  editTable,
  insertTable,
  insertText,
  removeTable,
  setTableCell,
} from "../src/operations";
import { TransactionLog, applyOp, invertOp, PrimOp } from "../src/oplog";
import { transformOp } from "../src/transform";
import { toHTML, toMarkdown } from "../src/serialize";
import { inspect } from "../src/inspector";
import { diffModels, diffSummary } from "../src/diff";
import { DocModel, SCHEMA_VERSION } from "../src/types";

function doc(): DocModel {
  return {
    schemaVersion: SCHEMA_VERSION,
    blocks: [newBlock("paragraph", [{ text: "Before the table.", marks: [] }])],
  };
}

test("insertTable creates [text][table][paragraph] and is one undo step", () => {
  const d = doc();
  const before = JSON.stringify(d);
  const log = new TransactionLog();
  log.begin();
  const caret = insertTable(d, { block: 0, offset: 5 }, 2, 3, log);
  assert.equal(d.blocks.length, 3);
  assert.equal(d.blocks[1]!.type, "table");
  assert.deepEqual(d.blocks[1]!.table, [["", "", ""], ["", "", ""]]);
  assert.equal(d.blocks[2]!.type, "paragraph");
  assert.deepEqual(caret, { block: 2, offset: 0 });
  assert.deepEqual(validateModel(d), []);
  assert.ok(log.undo(d));
  assert.equal(JSON.stringify(d), before, "one undo removes the whole insertion");
});

test("cell edits and structure edits are invertible", () => {
  const d = doc();
  const log = new TransactionLog();
  log.begin();
  insertTable(d, { block: 0, offset: 17 }, 2, 2, log);
  log.begin(null, Date.now() + 5000);
  setTableCell(d, 1, 0, 0, "Name", log);
  setTableCell(d, 1, 0, 1, "Rate", log);
  log.begin(null, Date.now() + 10000);
  editTable(d, 1, "add-row", log);
  editTable(d, 1, "add-col", log);
  assert.deepEqual(d.blocks[1]!.table, [
    ["Name", "Rate", ""],
    ["", "", ""],
    ["", "", ""],
  ]);
  assert.deepEqual(validateModel(d), []);
  log.undo(d);
  assert.deepEqual(d.blocks[1]!.table, [["Name", "Rate"], ["", ""]]);
  log.undo(d);
  assert.deepEqual(d.blocks[1]!.table, [["", ""], ["", ""]]);
  // removing the last row/col is refused quietly
  const d2 = doc();
  insertTable(d2, { block: 0, offset: 0 }, 1, 1);
  editTable(d2, 1, "remove-row");
  editTable(d2, 1, "remove-col");
  assert.deepEqual(d2.blocks[1]!.table, [[""]]);
});

test("removeTable drops content deliberately and inverts exactly", () => {
  const d = doc();
  insertTable(d, { block: 0, offset: 17 }, 2, 2);
  setTableCell(d, 1, 1, 1, "data");
  const withTable = JSON.stringify(d);
  const log = new TransactionLog();
  log.begin();
  removeTable(d, 1, log);
  assert.equal(d.blocks[1]!.type, "paragraph");
  assert.equal(d.blocks[1]!.table, undefined);
  assert.deepEqual(validateModel(d), []);
  log.undo(d);
  assert.equal(JSON.stringify(d), withTable);
});

test("set-table invertOp is an involution; validation enforces consistency", () => {
  const op: PrimOp = {
    t: "set-table",
    block: 0,
    beforeType: "paragraph",
    afterType: "table",
    beforeTable: null,
    afterTable: [["a"]],
    beforeRuns: [{ text: "Before the table.", marks: [] }],
  };
  assert.deepEqual(invertOp(invertOp(op)), op);
  const d = doc();
  const snap = JSON.stringify(d);
  applyOp(d, op);
  assert.deepEqual(validateModel(d), []);
  applyOp(d, invertOp(op));
  assert.equal(JSON.stringify(d), snap, "exact restore including runs");
});

test("model validation rejects malformed tables", () => {
  const d = doc();
  d.blocks.push({ id: "t1", type: "table", runs: [], table: [["a", "b"], ["c"]] });
  assert.ok(validateModel(d).some((e) => e.includes("rectangular")));
  d.blocks[1]!.table = [];
  assert.ok(validateModel(d).some((e) => e.includes("empty table")));
  d.blocks[1]!.table = [["x"]];
  d.blocks[0]!.table = [["nope"]];
  assert.ok(validateModel(d).some((e) => e.includes("non-table block")));
});

test("serializers: HTML grid, Markdown pipes with escaping, inspector label, diff", () => {
  const d = doc();
  insertTable(d, { block: 0, offset: 17 }, 2, 2);
  setTableCell(d, 1, 0, 0, "Col|A");
  setTableCell(d, 1, 1, 0, "multi\nline");
  const html = toHTML(d);
  assert.ok(html.includes("<table"), html);
  assert.ok(html.includes("<td>Col|A</td>"));
  const { markdown, report } = toMarkdown(d);
  assert.ok(markdown.includes("| Col\\|A |"), markdown);
  assert.ok(markdown.includes("| --- | --- |"));
  assert.ok(report.warnings.some((w) => w.code === "MD-TABLE-MULTILINE"));
  assert.ok(inspect(d).some((c) => c.label === "[Table 2×2]"));

  const d2 = JSON.parse(JSON.stringify(d)) as DocModel;
  setTableCell(d2, 1, 0, 1, "changed");
  const s = diffSummary(diffModels(d, d2));
  assert.equal(s.changed, 1, "cell edit shows as a changed block");
  assert.equal(docText(d2).includes("changed"), false, "table text stays out of docText");
});

test("transform: set-table shifts across splits/merges and conflicts on contested blocks", () => {
  const tb: PrimOp = {
    t: "set-table", block: 2, beforeType: "paragraph", afterType: "table",
    beforeTable: null, afterTable: [["x"]], beforeRuns: [],
  };
  const splitAbove: PrimOp = { t: "split-block", block: 0, offset: 3, newBlockId: "s", newBlockType: "paragraph", origType: "paragraph" };
  const r1 = transformOp(tb, splitAbove, "right");
  assert.equal(r1.conflict, false);
  assert.equal((r1.ops[0] as Extract<PrimOp, { t: "set-table" }>).block, 3, "index shifted past a split above");

  const editSame: PrimOp = { t: "replace-runs", block: 2, from: 0, to: 1, before: [{ text: "a", marks: [] }], after: [] };
  assert.equal(transformOp(tb, editSame, "right").conflict, true, "edit vs conversion conflicts");
  assert.equal(transformOp(editSame, tb, "left").conflict, true, "symmetric conflict");
  const tb2: PrimOp = { ...tb, afterTable: [["y"]] } as PrimOp;
  assert.equal(transformOp(tb2, tb, "right").conflict, true, "diverging conversions conflict");
  assert.equal(transformOp(structuredClone(tb), tb, "right").conflict, false, "identical conversions dedupe");
});
