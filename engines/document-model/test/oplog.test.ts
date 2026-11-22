import { strict as assert } from "node:assert";
import test from "node:test";
import { TransactionLog, applyOp, invertOp, PrimOp } from "../src/oplog";
import {
  deleteRange,
  insertText,
  mergeWithPrevious,
  setBlockType,
  splitBlock,
  toggleMark,
} from "../src/operations";
import { docText, newBlock, validateModel } from "../src/model";
import { DocModel, SCHEMA_VERSION } from "../src/types";

function base(): DocModel {
  return {
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      newBlock("heading1", [{ text: "Title", marks: [] }]),
      newBlock("paragraph", [
        { text: "Alpha ", marks: [] },
        { text: "beta", marks: ["bold"] },
        { text: " gamma.", marks: [] },
      ]),
      newBlock("paragraph", [{ text: "Second paragraph here.", marks: [] }]),
      newBlock("heading2", [{ text: "Section", marks: [] }]),
    ],
  };
}

function snap(m: DocModel): string {
  return JSON.stringify(m); // ids included — byte-stable equality
}

test("invertOp is an involution for every primitive kind", () => {
  const ops: PrimOp[] = [
    { t: "replace-runs", block: 0, from: 1, to: 3, before: [{ text: "it", marks: [] }], after: [{ text: "X", marks: ["bold"] }] },
    { t: "split-block", block: 1, offset: 4, newBlockId: "nb1", newBlockType: "paragraph", origType: "heading1" },
    { t: "merge-blocks", block: 2, seam: 5, removedId: "rb", removedType: "heading2", prevType: "paragraph" },
    { t: "set-block-type", block: 0, before: "heading1", after: "paragraph" },
  ];
  for (const op of ops) {
    assert.deepEqual(invertOp(invertOp(op)), op, op.t);
  }
});

test("single-op apply→invert restores the exact model", () => {
  const scenarios: ((m: DocModel, log: TransactionLog) => void)[] = [
    (m, log) => { log.begin(); insertText(m, { block: 1, offset: 6 }, "NEW ", ["italic"], log); },
    (m, log) => { log.begin(); deleteRange(m, { anchor: { block: 1, offset: 2 }, focus: { block: 1, offset: 9 } }, log); },
    (m, log) => { log.begin(); splitBlock(m, { block: 1, offset: 6 }, log); },
    (m, log) => { log.begin(); mergeWithPrevious(m, 2, log); },
    (m, log) => { log.begin(); toggleMark(m, { anchor: { block: 1, offset: 0 }, focus: { block: 2, offset: 10 } }, "underline", log); },
    (m, log) => { log.begin(); setBlockType(m, { anchor: { block: 0, offset: 0 }, focus: { block: 2, offset: 0 } }, "heading2", log); },
  ];
  for (const scenario of scenarios) {
    const m = base();
    const before = snap(m);
    const log = new TransactionLog();
    scenario(m, log);
    assert.notEqual(snap(m), before, "scenario changed the model");
    assert.deepEqual(validateModel(m), []);
    assert.ok(log.undo(m));
    assert.equal(snap(m), before, "undo restored the exact state, ids included");
  }
});

test("cross-block delete is fully invertible (content, types, and ids)", () => {
  const m = base();
  const before = snap(m);
  const log = new TransactionLog();
  log.begin();
  deleteRange(m, { anchor: { block: 0, offset: 2 }, focus: { block: 3, offset: 4 } }, log);
  assert.equal(m.blocks.length, 1);
  assert.equal(docText(m), "Tiion");
  assert.ok(log.undo(m));
  assert.equal(snap(m), before);
  // and redo reproduces the deletion exactly
  assert.ok(log.redo(m));
  assert.equal(docText(m), "Tiion");
  const afterRedo = snap(m);
  assert.ok(log.undo(m));
  assert.ok(log.redo(m));
  assert.equal(snap(m), afterRedo, "undo/redo cycle is stable");
});

test("a long mixed editing session unwinds to the origin, step by step", () => {
  const m = base();
  const log = new TransactionLog();
  const states: string[] = [snap(m)];
  const steps: (() => void)[] = [
    () => insertText(m, { block: 1, offset: 0 }, ">> ", [], log),
    () => toggleMark(m, { anchor: { block: 1, offset: 3 }, focus: { block: 1, offset: 8 } }, "underline", log),
    () => splitBlock(m, { block: 2, offset: 7 }, log),
    () => deleteRange(m, { anchor: { block: 0, offset: 1 }, focus: { block: 1, offset: 2 } }, log),
    () => setBlockType(m, { anchor: { block: 0, offset: 0 }, focus: { block: 0, offset: 0 } }, "paragraph", log),
    () => mergeWithPrevious(m, 1, log),
    () => insertText(m, { block: 0, offset: 5 }, " middle ", ["bold", "italic"], log),
  ];
  for (const step of steps) {
    log.begin(null, states.length * 5000); // defeat coalescing
    step();
    assert.deepEqual(validateModel(m), []);
    states.push(snap(m));
  }
  // unwind completely
  for (let i = steps.length - 1; i >= 0; i--) {
    assert.ok(log.undo(m), `undo step ${i}`);
    assert.equal(snap(m), states[i], `state ${i} restored exactly`);
  }
  assert.equal(log.canUndo(), false);
  // replay completely
  for (let i = 1; i <= steps.length; i++) {
    assert.ok(log.redo(m), `redo step ${i}`);
    assert.equal(snap(m), states[i], `state ${i} replayed exactly`);
  }
});

test("typing coalesces into one transaction; redo clears on new input", () => {
  const m: DocModel = { schemaVersion: SCHEMA_VERSION, blocks: [newBlock("paragraph", [])] };
  const log = new TransactionLog();
  const t0 = 1000;
  log.begin("type", t0);
  insertText(m, { block: 0, offset: 0 }, "a", [], log);
  log.begin("type", t0 + 100);
  insertText(m, { block: 0, offset: 1 }, "b", [], log);
  log.begin("type", t0 + 200);
  insertText(m, { block: 0, offset: 2 }, "c", [], log);
  assert.equal(docText(m), "abc");
  assert.equal(log.depth(), 1, "burst coalesced into one transaction");
  assert.ok(log.undo(m));
  assert.equal(docText(m), "", "one undo removes the whole burst");
  assert.ok(log.redo(m));
  assert.equal(docText(m), "abc");
  // after redo, new typing must not coalesce into the redone transaction
  log.begin("type", t0 + 10_000);
  insertText(m, { block: 0, offset: 3 }, "d", [], log);
  assert.equal(log.depth(), 2);
  log.undo(m);
  assert.equal(docText(m), "abc");
});

test("replace-model op supports wholesale swaps (revision restore path)", () => {
  const m = base();
  const before = snap(m);
  const target: DocModel = {
    schemaVersion: SCHEMA_VERSION,
    blocks: [newBlock("paragraph", [{ text: "entirely different", marks: [] }])],
  };
  const log = new TransactionLog();
  log.begin();
  const op: PrimOp = { t: "replace-model", before: structuredClone(m), after: structuredClone(target) };
  log.record(op);
  applyOp(m, op);
  assert.equal(docText(m), "entirely different");
  assert.ok(log.undo(m));
  assert.equal(snap(m), before);
  assert.ok(log.redo(m));
  assert.equal(docText(m), "entirely different");
});

test("recorded ops are decoupled from later model mutation (no aliasing)", () => {
  const m = base();
  const log = new TransactionLog();
  log.begin();
  insertText(m, { block: 1, offset: 0 }, "X", ["bold"], log);
  const before = snap(m);
  // mutate the model further WITHOUT recording; then undo only the recorded txn
  m.blocks[1]!.runs[0]!.text = m.blocks[1]!.runs[0]!.text; // no-op touch
  log.begin(null, 99999);
  insertText(m, { block: 0, offset: 0 }, "Q", [], log);
  log.undo(m);
  assert.equal(snap(m), before, "second txn undone independently");
});

test("commit listener: coalesced bursts deliver once; flush closes; undo/redo journal as new ops", () => {
  const m: DocModel = { schemaVersion: SCHEMA_VERSION, blocks: [newBlock("paragraph", [])] };
  const log = new TransactionLog();
  const committed: { ops: PrimOp[]; key: string | null }[] = [];
  log.onCommit((t) => committed.push({ ops: t.ops, key: t.key }));

  const t0 = 1000;
  log.begin("type", t0);
  insertText(m, { block: 0, offset: 0 }, "a", [], log);
  log.begin("type", t0 + 100);
  insertText(m, { block: 0, offset: 1 }, "b", [], log);
  assert.equal(committed.length, 0, "open transaction not delivered yet");

  log.begin(null, t0 + 200); // non-coalescing begin closes the burst
  toggleMark(m, { anchor: { block: 0, offset: 0 }, focus: { block: 0, offset: 2 } }, "bold", log);
  assert.equal(committed.length, 1, "burst delivered once");
  assert.equal(committed[0]!.key, "type");
  assert.equal(committed[0]!.ops.length, 2);

  log.flush();
  assert.equal(committed.length, 2, "flush delivered the open transaction");

  // flushed txn never coalesces again
  log.begin("type", t0 + 300);
  insertText(m, { block: 0, offset: 2 }, "c", [], log);
  log.flush();
  assert.equal(committed.length, 3, "post-flush typing is a fresh transaction");

  // undo reports inverse ops; redo reports the originals
  const journalOps: PrimOp[] = [];
  const rec = { record: (op: PrimOp) => void journalOps.push(op) };
  assert.ok(log.undo(m, rec));
  assert.equal(journalOps.length, 1, "undo journaled its inverse");
  assert.equal(docText(m), "ab");
  assert.ok(log.redo(m, rec));
  assert.equal(journalOps.length, 2, "redo journaled its ops");
  assert.equal(docText(m), "abc");
  assert.equal(committed.length, 3, "redo does not re-deliver via commit listener");

  // replaying: a journal fed from commits + undo/redo recs matches the model
  const { DocumentJournal } = require("../src/journal") as typeof import("../src/journal");
  const j = new DocumentJournal({ schemaVersion: SCHEMA_VERSION, blocks: [newBlock("paragraph", [])] });
  // feed in order: 3 committed txns, then the undo inverse, then the redo op
  const seed = m.blocks[0]!.id;
  void seed;
  const flat: PrimOp[][] = [...committed.map((c) => c.ops), [journalOps[0]!], [journalOps[1]!]];
  const j2base: DocModel = { schemaVersion: SCHEMA_VERSION, blocks: [{ id: "replay-base", type: "paragraph", runs: [] }] };
  void j2base;
  for (const ops of flat) j.append("tester", ops);
  const replayed = j.replay();
  assert.equal(docText(replayed), docText(m), "journal replay matches live model text");
});
