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
  const html = toHTML(doc());
  assert.ok(html.includes("<ul>\n<li>first bullet</li>\n<li><strong>second bullet</strong></li>\n</ul>"), html);
  assert.ok(html.includes("<ol>\n<li>step one</li>\n<li>step two</li>\n</ol>"), "ol grouped");
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
