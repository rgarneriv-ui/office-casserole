import { strict as assert } from "node:assert";
import test from "node:test";
import { newBlock, blockText } from "../src/model";
import { splitBlock } from "../src/operations";
import { toHTML, toMarkdown } from "../src/serialize";
import { inspect } from "../src/inspector";
import { DocModel, SCHEMA_VERSION } from "../src/types";

function doc(): DocModel {
  return {
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      newBlock("heading2", [{ text: "Checklist", marks: [] }]),
      newBlock("bullet", [{ text: "first bullet", marks: [] }]),
      newBlock("bullet", [{ text: "second bullet", marks: ["bold"] }]),
      newBlock("numbered", [{ text: "step one", marks: [] }]),
      newBlock("numbered", [{ text: "step two", marks: [] }]),
      newBlock("paragraph", [{ text: "outro", marks: [] }]),
      newBlock("numbered", [{ text: "restarted", marks: [] }]),
    ],
  };
}

test("HTML export groups consecutive list items into ul/ol", () => {
  const html = toHTML(doc()).replace(/\n/g, "");
  assert.ok(html.includes("<ul><li>first bullet</li><li><strong>second bullet</strong></li></ul>"), html);
  assert.ok(html.includes("<ol><li>step one</li><li>step two</li></ol>"), "ol grouped");
  // the second numbered run is its own list, not merged across the paragraph
  assert.equal((html.match(/<ol>/g) ?? []).length, 2);
});

test("Markdown export numbers lists and restarts after interruptions", () => {
  const { markdown, report } = toMarkdown(doc());
  assert.ok(markdown.includes("- first bullet"));
  assert.ok(markdown.includes("1. step one"));
  assert.ok(markdown.includes("2. step two"));
  assert.ok(markdown.includes("1. restarted"), "numbering restarts after a paragraph");
  assert.equal(report.lossless, true, "lists are representable in Markdown");
});

test("Enter continues a list; heading split rules unchanged", () => {
  const d = doc();
  splitBlock(d, { block: 1, offset: blockText(d.blocks[1]!).length });
  assert.equal(d.blocks[2]!.type, "bullet", "new item continues the bulleted list");
  const d2 = doc();
  splitBlock(d2, { block: 3, offset: 4 });
  assert.equal(d2.blocks[4]!.type, "numbered", "mid-split keeps numbered");
  const d3 = doc();
  splitBlock(d3, { block: 0, offset: blockText(d3.blocks[0]!).length });
  assert.equal(d3.blocks[1]!.type, "paragraph", "heading end-split still yields a paragraph");
});

test("Reveal Codes labels list blocks", () => {
  const codes = inspect(doc());
  assert.ok(codes.some((c) => c.label === "[Bullet]"));
  assert.ok(codes.some((c) => c.label === "[Numbered]"));
});

// ---------- nesting (WO-25) ----------
import { setListIndent } from "../src/operations";
import { TransactionLog } from "../src/oplog";
import { ListCounter, numberedMarker } from "../src/listmarks";
import { validateModel } from "../src/model";

function nested(): DocModel {
  const d: DocModel = { schemaVersion: SCHEMA_VERSION, blocks: [
    newBlock("numbered", [{ text: "top one", marks: [] }]),
    newBlock("numbered", [{ text: "sub a", marks: [] }]),
    newBlock("numbered", [{ text: "sub b", marks: [] }]),
    newBlock("numbered", [{ text: "top two", marks: [] }]),
    newBlock("bullet", [{ text: "deep", marks: [] }]),
  ]};
  d.blocks[1]!.indent = 1;
  d.blocks[2]!.indent = 1;
  d.blocks[4]!.indent = 2;
  return d;
}

test("setListIndent clamps, skips non-lists, and inverts exactly", () => {
  const d = nested();
  const before = JSON.stringify(d);
  const log = new TransactionLog();
  log.begin();
  setListIndent(d, { anchor: { block: 0, offset: 0 }, focus: { block: 4, offset: 0 } }, 1, log);
  assert.deepEqual(d.blocks.map((b) => b.indent ?? 0), [1, 2, 2, 1, 3]);
  assert.deepEqual(validateModel(d), []);
  log.begin(null, Date.now() + 5000);
  setListIndent(d, { anchor: { block: 4, offset: 0 }, focus: { block: 4, offset: 0 } }, 1, log);
  assert.equal(d.blocks[4]!.indent, 3, "clamped at 3 — no-op emitted nothing");
  assert.ok(log.undo(d));
  assert.equal(JSON.stringify(d), before, "single undo restores all levels");
});

test("split inherits indent; markers follow 1./a./i./1) with resets", () => {
  const d = nested();
  splitBlock(d, { block: 1, offset: blockText(d.blocks[1]!).length });
  assert.equal(d.blocks[2]!.type, "numbered");
  assert.equal(d.blocks[2]!.indent, 1, "new item keeps nesting level");

  const c = new ListCounter();
  const out: (string | null)[] = [];
  for (const [type, lvl] of [["numbered",0],["numbered",1],["numbered",1],["numbered",2],["numbered",0],["numbered",1]] as const) {
    out.push(c.next(type, lvl));
  }
  assert.deepEqual(out, ["1.", "a.", "b.", "i.", "2.", "a."], "sub-counters reset after returning to a shallower level");
  assert.equal(numberedMarker(3, 2), "2)");
});

test("nested HTML is properly nested; Markdown indents with digit markers", () => {
  const d = nested();
  const html = toHTML(d).replace(/\n/g, "");
  assert.ok(html.includes("<ol><li>top one<ol><li>sub a</li><li>sub b</li></ol></li><li>top two<ul><li>deep</li></ul></li></ol>"), html);
  const { markdown } = toMarkdown(d);
  assert.ok(markdown.includes("1. top one"));
  assert.ok(markdown.includes("    1. sub a"), markdown);
  assert.ok(markdown.includes("    2. sub b"));
  assert.ok(markdown.includes("        - deep"));
});
