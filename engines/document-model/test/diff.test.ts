import { strict as assert } from "node:assert";
import test from "node:test";
import { diffModels, diffSummary } from "../src/diff";
import { newBlock } from "../src/model";
import { insertText, splitBlock, toggleMark, deleteRange } from "../src/operations";
import { DocModel, SCHEMA_VERSION } from "../src/types";

function clone(d: DocModel): DocModel {
  return structuredClone(d);
}

function base(): DocModel {
  return {
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      newBlock("heading1", [{ text: "Title", marks: [] }]),
      newBlock("paragraph", [{ text: "First paragraph.", marks: [] }]),
      newBlock("paragraph", [{ text: "Second paragraph.", marks: [] }]),
    ],
  };
}

test("identical documents diff as all-unchanged", () => {
  const a = base();
  const entries = diffModels(a, clone(a));
  assert.ok(entries.every((e) => e.kind === "unchanged"));
  assert.deepEqual(diffSummary(entries), { added: 0, removed: 0, changed: 0, unchanged: 3 });
});

test("text edit shows as changed with textChanged=true", () => {
  const a = base();
  const b = clone(a);
  insertText(b, { block: 1, offset: 5 }, " edited");
  const entries = diffModels(a, b);
  const changed = entries.filter((e) => e.kind === "changed");
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.a, 1);
  assert.equal(changed[0]!.textChanged, true);
});

test("formatting-only change is distinguished from a text change", () => {
  const a = base();
  const b = clone(a);
  toggleMark(b, { anchor: { block: 2, offset: 0 }, focus: { block: 2, offset: 6 } }, "bold");
  const entries = diffModels(a, b);
  const changed = entries.filter((e) => e.kind === "changed");
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.textChanged, false);
  assert.equal(changed[0]!.formattingChanged, true);
});

test("split produces one changed and one added block, not a cascade", () => {
  const a = base();
  const b = clone(a);
  splitBlock(b, { block: 1, offset: 5 });
  const entries = diffModels(a, b);
  const s = diffSummary(entries);
  assert.equal(s.added, 1);
  assert.equal(s.removed, 0);
  assert.equal(s.changed, 1); // the shortened first half
  assert.equal(s.unchanged, 2); // title + second paragraph unaffected
});

test("cross-block delete shows removed blocks without disturbing the rest", () => {
  const a = base();
  const b = clone(a);
  deleteRange(b, { anchor: { block: 1, offset: 0 }, focus: { block: 2, offset: 17 } });
  const entries = diffModels(a, b);
  const s = diffSummary(entries);
  assert.equal(s.removed, 1);
  assert.equal(entries.find((e) => e.kind === "unchanged" && e.a === 0)?.b, 0);
});

// ---------- word-level diff (WO-31) ----------
import { diffBlockText } from "../src/diff";

test("diffBlockText: word-level ins/del with merged segments", () => {
  const segs = diffBlockText(
    "The quick brown fox jumps over the dog.",
    "The quick red fox leaps over the lazy dog."
  );
  const by = (k: string) => segs.filter((s) => s.kind === k).map((s) => s.text.trim()).join("|");
  assert.equal(by("del"), "brown|jumps");
  assert.equal(by("ins"), "red|leaps|lazy");
  // reconstructions: same+del = old, same+ins = new
  assert.equal(segs.filter((s) => s.kind !== "ins").map((s) => s.text).join(""), "The quick brown fox jumps over the dog.");
  assert.equal(segs.filter((s) => s.kind !== "del").map((s) => s.text).join(""), "The quick red fox leaps over the lazy dog.");
});

test("diffBlockText: edge cases — empty sides and total replacement", () => {
  assert.deepEqual(diffBlockText("", "new text"), [{ kind: "ins", text: "new text" }]);
  assert.deepEqual(diffBlockText("old", ""), [{ kind: "del", text: "old" }]);
  const segs = diffBlockText("alpha beta", "gamma delta");
  assert.ok(segs.every((s) => s.kind !== "same" || /^\s+$/.test(s.text)));
  assert.deepEqual(diffBlockText("", ""), []);
});
