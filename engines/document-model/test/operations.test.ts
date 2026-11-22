import { strict as assert } from "node:assert";
import test from "node:test";
import {
  deleteRange,
  insertText,
  mergeWithPrevious,
  rangeHasMark,
  setBlockType,
  splitBlock,
  toggleMark,
} from "../src/operations";
import { docText, newBlock, validateModel } from "../src/model";
import { History } from "../src/history";
import { DocModel, SCHEMA_VERSION } from "../src/types";

function doc(...blocks: DocModel["blocks"]): DocModel {
  return { schemaVersion: SCHEMA_VERSION, blocks };
}

function para(text: string) {
  return newBlock("paragraph", text ? [{ text, marks: [] }] : []);
}

test("insertText advances the caret and keeps the model valid", () => {
  const d = doc(para("Held"));
  const caret = insertText(d, { block: 0, offset: 3 }, "lo wor");
  assert.equal(docText(d), "Hello word");
  assert.deepEqual(caret, { block: 0, offset: 9 });
  assert.deepEqual(validateModel(d), []);
});

test("insertText with marks creates a distinct run", () => {
  const d = doc(para("ac"));
  insertText(d, { block: 0, offset: 1 }, "b", ["bold"]);
  assert.equal(d.blocks[0]!.runs.length, 3);
  assert.deepEqual(d.blocks[0]!.runs[1], { text: "b", marks: ["bold"] });
});

test("deleteRange within a block", () => {
  const d = doc(para("Hello world"));
  const caret = deleteRange(d, {
    anchor: { block: 0, offset: 5 },
    focus: { block: 0, offset: 11 },
  });
  assert.equal(docText(d), "Hello");
  assert.deepEqual(caret, { block: 0, offset: 5 });
});

test("deleteRange across blocks joins first and last", () => {
  const d = doc(para("one two"), para("middle"), para("three four"));
  const caret = deleteRange(d, {
    anchor: { block: 0, offset: 4 },
    focus: { block: 2, offset: 6 },
  });
  assert.equal(docText(d), "one four");
  assert.equal(d.blocks.length, 1);
  assert.deepEqual(caret, { block: 0, offset: 4 });
  assert.deepEqual(validateModel(d), []);
});

test("backward (focus-before-anchor) ranges are normalized", () => {
  const d = doc(para("abcdef"));
  deleteRange(d, { anchor: { block: 0, offset: 4 }, focus: { block: 0, offset: 2 } });
  assert.equal(docText(d), "abef");
});

test("splitBlock at the end of a heading starts a paragraph", () => {
  const d = doc(newBlock("heading1", [{ text: "Title", marks: [] }]));
  const caret = splitBlock(d, { block: 0, offset: 5 });
  assert.equal(d.blocks.length, 2);
  assert.equal(d.blocks[1]!.type, "paragraph");
  assert.deepEqual(caret, { block: 1, offset: 0 });
});

test("splitBlock mid-heading keeps the remainder a heading", () => {
  const d = doc(newBlock("heading1", [{ text: "TitleTail", marks: [] }]));
  splitBlock(d, { block: 0, offset: 5 });
  assert.equal(d.blocks[1]!.type, "heading1");
  assert.equal(docText(d), "Title\nTail");
});

test("mergeWithPrevious joins blocks and places the caret at the seam", () => {
  const d = doc(para("Hello"), para("world"));
  const caret = mergeWithPrevious(d, 1);
  assert.equal(docText(d), "Helloworld");
  assert.deepEqual(caret, { block: 0, offset: 5 });
});

test("toggleMark applies, detects, and removes a mark across blocks", () => {
  const d = doc(para("one"), para("two"));
  const range = { anchor: { block: 0, offset: 1 }, focus: { block: 1, offset: 2 } };
  assert.equal(rangeHasMark(d, range, "bold"), false);
  toggleMark(d, range, "bold");
  assert.equal(rangeHasMark(d, range, "bold"), true);
  assert.deepEqual(validateModel(d), []);
  toggleMark(d, range, "bold"); // toggles off
  assert.equal(rangeHasMark(d, range, "bold"), false);
  assert.equal(docText(d), "one\ntwo");
});

test("setBlockType converts every touched block", () => {
  const d = doc(para("a"), para("b"), para("c"));
  setBlockType(d, { anchor: { block: 0, offset: 0 }, focus: { block: 1, offset: 1 } }, "heading2");
  assert.equal(d.blocks[0]!.type, "heading2");
  assert.equal(d.blocks[1]!.type, "heading2");
  assert.equal(d.blocks[2]!.type, "paragraph");
});

test("undo/redo restore exact states; typing coalesces into one step", () => {
  let d = doc(para(""));
  const h = new History();

  // three keystrokes coalesce (same key, same instant)
  const t0 = 1000;
  h.checkpoint(d, "type", t0);
  insertText(d, { block: 0, offset: 0 }, "a");
  h.checkpoint(d, "type", t0 + 100);
  insertText(d, { block: 0, offset: 1 }, "b");
  h.checkpoint(d, "type", t0 + 200);
  insertText(d, { block: 0, offset: 2 }, "c");
  assert.equal(docText(d), "abc");

  // a distinct transaction
  h.checkpoint(d, null, t0 + 300);
  toggleMark(d, { anchor: { block: 0, offset: 0 }, focus: { block: 0, offset: 3 } }, "bold");
  assert.equal(rangeHasMark(d, { anchor: { block: 0, offset: 0 }, focus: { block: 0, offset: 3 } }, "bold"), true);

  const afterBold = d;
  d = h.undo(d)!;
  assert.equal(rangeHasMark(d, { anchor: { block: 0, offset: 0 }, focus: { block: 0, offset: 3 } }, "bold"), false);
  assert.equal(docText(d), "abc");

  d = h.undo(d)!; // undoes the whole coalesced typing burst
  assert.equal(docText(d), "");

  d = h.redo(d)!;
  assert.equal(docText(d), "abc");
  d = h.redo(d)!;
  assert.equal(docText(d), docText(afterBold));
  assert.equal(h.canRedo(), false);
});
