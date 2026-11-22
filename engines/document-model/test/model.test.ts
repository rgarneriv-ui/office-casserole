import { strict as assert } from "node:assert";
import test from "node:test";
import {
  blockText,
  docText,
  marksAt,
  newBlock,
  newDocument,
  normalizeModel,
  runsSlice,
  splitRunsAt,
  validateModel,
} from "../src/model";
import { DocModel, SCHEMA_VERSION } from "../src/types";

test("new document is valid and has one empty paragraph", () => {
  const doc = newDocument();
  assert.equal(doc.blocks.length, 1);
  assert.equal(doc.blocks[0]!.type, "paragraph");
  assert.deepEqual(validateModel(doc), []);
});

test("normalize merges adjacent runs with equal marks and drops empty runs", () => {
  const doc: DocModel = {
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      {
        id: "x",
        type: "paragraph",
        runs: [
          { text: "Hel", marks: ["bold"] },
          { text: "", marks: [] },
          { text: "lo", marks: ["bold"] },
          { text: " world", marks: [] },
        ],
      },
    ],
  };
  normalizeModel(doc);
  assert.equal(doc.blocks[0]!.runs.length, 2);
  assert.equal(doc.blocks[0]!.runs[0]!.text, "Hello");
  assert.deepEqual(validateModel(doc), []);
});

test("validate catches unmerged runs and empty runs", () => {
  const doc: DocModel = {
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      {
        id: "x",
        type: "paragraph",
        runs: [
          { text: "a", marks: [] },
          { text: "b", marks: [] },
        ],
      },
    ],
  };
  assert.ok(validateModel(doc).length > 0);
});

test("splitRunsAt cuts across run boundaries", () => {
  const runs = [
    { text: "abc", marks: ["bold" as const] },
    { text: "def", marks: [] },
  ];
  const [left, right] = splitRunsAt(runs, 4);
  assert.equal(left.map((r) => r.text).join("|"), "abc|d");
  assert.equal(right.map((r) => r.text).join("|"), "ef");
});

test("runsSlice copies the middle with marks intact", () => {
  const runs = [
    { text: "abc", marks: ["bold" as const] },
    { text: "def", marks: [] },
  ];
  const mid = runsSlice(runs, 2, 5);
  assert.equal(mid.map((r) => r.text).join(""), "cde");
  assert.deepEqual(mid[0]!.marks, ["bold"]);
});

test("marksAt reports the mark set in force before the caret", () => {
  const block = newBlock("paragraph", [
    { text: "ab", marks: ["bold"] },
    { text: "cd", marks: [] },
  ]);
  assert.deepEqual(marksAt(block, 2), ["bold"]);
  assert.deepEqual(marksAt(block, 3), []);
});

test("docText joins blocks with newlines", () => {
  const doc: DocModel = {
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      newBlock("heading1", [{ text: "Title", marks: [] }]),
      newBlock("paragraph", [{ text: "Body", marks: [] }]),
    ],
  };
  assert.equal(docText(doc), "Title\nBody");
  assert.equal(blockText(doc.blocks[0]!), "Title");
});
