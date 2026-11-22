import { strict as assert } from "node:assert";
import test from "node:test";
import {
  applyCodeAction,
  codeActionsFor,
  inspect,
  markSpanOf,
} from "../src/inspector";
import { newBlock, validateModel, docText } from "../src/model";
import { rangeHasMark } from "../src/operations";
import { DocModel, SCHEMA_VERSION } from "../src/types";

function sample(): DocModel {
  return {
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      newBlock("heading1", [{ text: "Title", marks: [] }]),
      newBlock("paragraph", [
        { text: "aa ", marks: [] },
        { text: "bold bit", marks: ["bold"] },
        { text: " zz ", marks: [] },
        { text: "both", marks: ["bold", "italic"] },
      ]),
    ],
  };
}

test("codeActionsFor exposes actions only on supported codes", () => {
  const codes = inspect(sample());
  const byKind = (k: string) => codes.find((c) => c.kind === k)!;
  assert.deepEqual(codeActionsFor(byKind("mark-on")), ["remove-mark"]);
  assert.deepEqual(codeActionsFor(byKind("mark-off")), ["remove-mark"]);
  assert.deepEqual(codeActionsFor(byKind("block-start")), ["set-block-type"]);
  assert.deepEqual(codeActionsFor(byKind("text")), []);
});

test("markSpanOf finds the maximal span adjoining a code", () => {
  const model = sample();
  const codes = inspect(model);
  const boldOn = codes.find((c) => c.label === "[Bold On]")!;
  const span = markSpanOf(model, boldOn)!;
  assert.equal(span.mark, "bold");
  assert.equal(span.start, 3); // after "aa "
  // bold runs through "bold bit" (8) + " zz " is unbold… wait " zz " breaks it
  assert.equal(span.end, 11); // "bold bit" ends at 3+8
});

test("remove-mark via a code strips exactly that span and keeps the model valid", () => {
  const model = sample();
  const codes = inspect(model);
  const boldOn = codes.find((c) => c.label === "[Bold On]")!;
  const msg = applyCodeAction(model, boldOn, { kind: "remove-mark" });
  assert.ok(msg && msg.includes("Bold"));
  assert.deepEqual(validateModel(model), []);
  // first bold span is gone…
  assert.equal(
    rangeHasMark(model, { anchor: { block: 1, offset: 3 }, focus: { block: 1, offset: 11 } }, "bold"),
    false
  );
  // …but the later bold+italic span keeps its bold
  const len = docText(model).split("\n")[1]!.length;
  assert.equal(
    rangeHasMark(model, { anchor: { block: 1, offset: len - 4 }, focus: { block: 1, offset: len } }, "bold"),
    true
  );
});

test("remove-mark via a mark-off code targets the span that ends there", () => {
  const model = sample();
  const codes = inspect(model);
  const boldOff = codes.find((c) => c.label === "[Bold Off]")!;
  const span = markSpanOf(model, boldOff)!;
  assert.equal(span.start, 3);
  assert.equal(span.end, 11);
});

test("set-block-type via a block-start code retypes the block", () => {
  const model = sample();
  const codes = inspect(model);
  const h1 = codes.find((c) => c.kind === "block-start" && c.blockIndex === 0)!;
  const msg = applyCodeAction(model, h1, { kind: "set-block-type", blockType: "paragraph" });
  assert.ok(msg);
  assert.equal(model.blocks[0]!.type, "paragraph");
  assert.deepEqual(validateModel(model), []);
});

test("unsupported action/code combinations return null and change nothing", () => {
  const model = sample();
  const before = JSON.stringify(model);
  const textCode = inspect(model).find((c) => c.kind === "text")!;
  assert.equal(applyCodeAction(model, textCode, { kind: "remove-mark" }), null);
  assert.equal(JSON.stringify(model), before);
});
