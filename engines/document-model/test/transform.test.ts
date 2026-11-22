import { strict as assert } from "node:assert";
import test from "node:test";
import { PrimOp, applyOp } from "../src/oplog";
import { rebaseSequence, transformOp } from "../src/transform";
import { DocumentJournal } from "../src/journal";
import { newBlock, validateModel, docText } from "../src/model";
import { insertText, deleteRange, splitBlock, toggleMark } from "../src/operations";
import { DocModel, SCHEMA_VERSION } from "../src/types";

// One origin, cloned per use — both replicas must share block ids, exactly
// as two clients sharing a document would.
const ORIGIN: DocModel = {
  schemaVersion: SCHEMA_VERSION,
  blocks: [
    newBlock("heading1", [{ text: "Title here", marks: [] }]),
    newBlock("paragraph", [{ text: "Alpha beta gamma delta.", marks: [] }]),
    newBlock("paragraph", [{ text: "Second paragraph.", marks: [] }]),
  ],
};

function base(): DocModel {
  return structuredClone(ORIGIN);
}

function clone(m: DocModel): DocModel {
  return structuredClone(m);
}

function snap(m: DocModel): string {
  return JSON.stringify(m);
}

/** TP1: apply(S, a then b') === apply(S, b then a'). */
function assertConverges(a: PrimOp, b: PrimOp, label: string): void {
  const s1 = base();
  applyOp(s1, a);
  const rb = transformOp(b, a, "right");
  assert.equal(rb.conflict, false, `${label}: b over a conflicted: ${rb.reason}`);
  for (const op of rb.ops) applyOp(s1, op);

  const s2 = base();
  applyOp(s2, b);
  const ra = transformOp(a, b, "left");
  assert.equal(ra.conflict, false, `${label}: a over b conflicted: ${ra.reason}`);
  for (const op of ra.ops) applyOp(s2, op);

  assert.deepEqual(validateModel(s1), [], label);
  assert.equal(snap(s1), snap(s2), `${label}: divergence\nA-first: ${docText(s1)}\nB-first: ${docText(s2)}`);
}

const rr = (block: number, from: number, to: number, before: string, after: string): PrimOp => ({
  t: "replace-runs",
  block,
  from,
  to,
  before: before ? [{ text: before, marks: [] }] : [],
  after: after ? [{ text: after, marks: [] }] : [],
});

test("TP1: replace/replace pairs converge", () => {
  // disjoint, same block ("Alpha beta gamma delta.")
  assertConverges(rr(1, 0, 5, "Alpha", "ALPHA"), rr(1, 11, 16, "gamma", "G"), "disjoint same block");
  assertConverges(rr(1, 11, 16, "gamma", "G"), rr(1, 0, 5, "Alpha", "A"), "disjoint reversed");
  // different blocks
  assertConverges(rr(0, 0, 5, "Title", "Header"), rr(1, 6, 10, "beta", "B"), "different blocks");
  // insert vs disjoint delete
  assertConverges(rr(1, 6, 6, "", "INS "), rr(1, 11, 16, "gamma", ""), "insert before delete");
  // same-point concurrent inserts (bias decides order deterministically)
  assertConverges(rr(1, 6, 6, "", "AAA"), rr(1, 6, 6, "", "BBB"), "same-point inserts");
});

test("TP1: replace vs split", () => {
  const split: PrimOp = { t: "split-block", block: 1, offset: 11, newBlockId: "nbX", newBlockType: "paragraph", origType: "paragraph" };
  assertConverges(split, rr(1, 0, 5, "Alpha", "A"), "edit in first half vs split");
  assertConverges(split, rr(1, 11, 16, "gamma", "GG"), "edit in second half vs split");
  assertConverges(split, rr(2, 0, 6, "Second", "2nd"), "edit below vs split");
  // delete straddling the split point partitions into two deletes
  assertConverges(split, rr(1, 6, 16, "beta gamma", ""), "straddling delete vs split");
});

test("TP1: replace vs merge", () => {
  const merge: PrimOp = { t: "merge-blocks", block: 2, seam: 23, removedId: "x", removedType: "paragraph", prevType: "paragraph" };
  assertConverges(merge, rr(2, 0, 6, "Second", "2nd"), "edit in merged-away block");
  assertConverges(merge, rr(1, 0, 5, "Alpha", "ALPHA!"), "edit in predecessor (seam shifts)");
  assertConverges(merge, rr(0, 0, 5, "Title", "T"), "edit above merge");
});

test("TP1: split vs split and split vs merge", () => {
  const spA: PrimOp = { t: "split-block", block: 1, offset: 5, newBlockId: "nbA", newBlockType: "paragraph", origType: "paragraph" };
  const spB: PrimOp = { t: "split-block", block: 1, offset: 11, newBlockId: "nbB", newBlockType: "paragraph", origType: "paragraph" };
  assertConverges(spA, spB, "two splits in one block");
  const spOther: PrimOp = { t: "split-block", block: 0, offset: 5, newBlockId: "nbC", newBlockType: "paragraph", origType: "heading1" };
  assertConverges(spOther, spB, "splits in different blocks");
  const mg: PrimOp = { t: "merge-blocks", block: 2, seam: 23, removedId: "x", removedType: "paragraph", prevType: "paragraph" };
  assertConverges(mg, spA, "split predecessor vs merge");
  assertConverges(mg, { t: "split-block", block: 2, offset: 6, newBlockId: "nbD", newBlockType: "paragraph", origType: "paragraph" }, "split merged-away block vs merge");
  // adjacent merges
  const mgA: PrimOp = { t: "merge-blocks", block: 1, seam: 10, removedId: "r1", removedType: "paragraph", prevType: "heading1" };
  assertConverges(mgA, mg, "adjacent merges chain");
});

test("TP1: set-block-type pairs", () => {
  const st: PrimOp = { t: "set-block-type", block: 2, before: "paragraph", after: "heading2" };
  assertConverges(st, rr(2, 0, 6, "Second", "2nd"), "retype vs edit");
  assertConverges(st, { t: "split-block", block: 1, offset: 5, newBlockId: "nbE", newBlockType: "paragraph", origType: "paragraph" }, "retype vs split above");
  assertConverges(st, { t: "set-block-type", block: 2, before: "paragraph", after: "heading2" }, "identical retypes");
  assertConverges(st, { t: "set-block-type", block: 0, before: "heading1", after: "paragraph" }, "retypes of different blocks");
});

test("conflicts are surfaced, never silently merged", () => {
  const cases: [PrimOp, PrimOp, string][] = [
    [rr(1, 4, 10, "a beta", "X"), rr(1, 6, 16, "beta gamma", "Y"), "overlapping replaces"],
    [{ t: "split-block", block: 1, offset: 8, newBlockId: "n1", newBlockType: "paragraph", origType: "paragraph" }, rr(1, 6, 10, "beta", "REPL"), "split inside replaced (non-delete) range"],
    [{ t: "split-block", block: 1, offset: 6, newBlockId: "n2", newBlockType: "paragraph", origType: "paragraph" }, { t: "split-block", block: 1, offset: 6, newBlockId: "n3", newBlockType: "paragraph", origType: "paragraph" }, "same-point splits"],
    [{ t: "merge-blocks", block: 2, seam: 23, removedId: "x", removedType: "paragraph", prevType: "paragraph" }, { t: "merge-blocks", block: 2, seam: 23, removedId: "x", removedType: "paragraph", prevType: "paragraph" }, "double merge"],
    [{ t: "set-block-type", block: 2, before: "paragraph", after: "heading2" }, { t: "merge-blocks", block: 2, seam: 23, removedId: "x", removedType: "paragraph", prevType: "paragraph" }, "retype vs merged away"],
    [{ t: "set-block-type", block: 2, before: "paragraph", after: "heading2" }, { t: "set-block-type", block: 2, before: "paragraph", after: "heading1" }, "diverging retypes"],
  ];
  for (const [b, a, label] of cases) {
    const r = transformOp(b, a, "right");
    assert.equal(r.conflict, true, `${label} should conflict`);
    assert.ok(r.reason, `${label} carries a reason`);
  }
});

test("rebaseSequence: transactions rebase whole or are rejected whole", () => {
  const b: PrimOp[] = [rr(1, 6, 6, "", "one "), rr(1, 10, 10, "", "two ")];
  const a: PrimOp[] = [rr(1, 0, 5, "Alpha", "ALPHA-PRIME")];
  const r = rebaseSequence(b, a, "right");
  assert.equal(r.conflict, false);

  const s1 = base();
  for (const op of a) applyOp(s1, op);
  for (const op of r.ops) applyOp(s1, op);
  const r2 = rebaseSequence(a, b, "left");
  const s2 = base();
  for (const op of b) applyOp(s2, op);
  for (const op of r2.ops) applyOp(s2, op);
  assert.equal(snap(s1), snap(s2), "sequence-level convergence");
  assert.ok(docText(s1).includes("one two "), docText(s1));

  // one conflicting op rejects the whole transaction
  const conflicting: PrimOp[] = [rr(2, 0, 6, "Second", "OK"), rr(1, 2, 8, "pha be", "X")];
  const rc = rebaseSequence(conflicting, [rr(1, 6, 16, "beta gamma", "")], "right");
  assert.equal(rc.conflict, true);
  assert.equal(rc.ops.length, 0);
});

test("two replicas editing concurrently converge through rebase", () => {
  const origin = base();

  // Replica A: structural work + edits (recorded through the real operations)
  const aModel = clone(origin);
  const aOps: PrimOp[] = [];
  const aRec = { record: (op: PrimOp) => void aOps.push(structuredClone(op)) };
  insertText(aModel, { block: 0, offset: 10 }, " (draft)", [], aRec);
  splitBlock(aModel, { block: 2, offset: 6 }, aRec);
  toggleMark(aModel, { anchor: { block: 1, offset: 0 }, focus: { block: 1, offset: 5 } }, "bold", aRec);

  // Replica B: concurrent edits elsewhere
  const bModel = clone(origin);
  const bOps: PrimOp[] = [];
  const bRec = { record: (op: PrimOp) => void bOps.push(structuredClone(op)) };
  insertText(bModel, { block: 1, offset: 23 }, " Added by B.", [], bRec);
  deleteRange(bModel, { anchor: { block: 2, offset: 0 }, focus: { block: 2, offset: 7 } }, bRec);

  // A's replica: apply B rebased over A
  const bOverA = rebaseSequence(bOps, aOps, "right");
  assert.equal(bOverA.conflict, false, bOverA.reason ?? "");
  for (const op of bOverA.ops) applyOp(aModel, op);

  // B's replica: apply A rebased over B
  const aOverB = rebaseSequence(aOps, bOps, "left");
  assert.equal(aOverB.conflict, false, aOverB.reason ?? "");
  for (const op of aOverB.ops) applyOp(bModel, op);

  assert.deepEqual(validateModel(aModel), []);
  assert.equal(snap(aModel), snap(bModel), `replicas diverged:\nA: ${docText(aModel)}\nB: ${docText(bModel)}`);
  assert.ok(docText(aModel).includes("(draft)"));
  assert.ok(docText(aModel).includes("Added by B."));
});

test("journal: append/replay determinism, round-trip, compaction, attribution", () => {
  const journal = new DocumentJournal(base());
  const m = base();
  const rec: PrimOp[] = [];
  const r = { record: (op: PrimOp) => void rec.push(op) };

  insertText(m, { block: 0, offset: 5 }, " ONE", [], r);
  journal.append("rob", rec.splice(0));
  splitBlock(m, { block: 1, offset: 11 }, r);
  journal.append("claude", rec.splice(0));
  deleteRange(m, { anchor: { block: 0, offset: 0 }, focus: { block: 0, offset: 5 } }, r);
  journal.append("rob", rec.splice(0));

  assert.equal(snap(journal.replay()), snap(m), "replay matches live mutation");
  assert.deepEqual(journal.actors(), ["rob", "claude"]);

  const restored = DocumentJournal.fromJSON(journal.toJSON());
  assert.equal(snap(restored.replay()), snap(m), "serialization round-trip");

  restored.compact(2);
  assert.equal(restored.size(), 1, "compaction folded early entries");
  assert.equal(snap(restored.replay()), snap(m), "compaction preserves replay");

  assert.throws(() => DocumentJournal.fromJSON('{"formatVersion":"9.9"}'));
  assert.throws(() =>
    journal.append("x", [{ t: "replace-runs", block: -1, from: 0, to: 0, before: [], after: [] } as PrimOp])
  );
});
