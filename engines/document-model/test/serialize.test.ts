import { strict as assert } from "node:assert";
import test from "node:test";
import { fromJSON, toHTML, toJSON, toMarkdown } from "../src/serialize";
import { inspect, explainAt } from "../src/inspector";
import { newBlock, docText } from "../src/model";
import { DocModel, SCHEMA_VERSION } from "../src/types";

function sample(): DocModel {
  return {
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      newBlock("heading1", [{ text: "Quarterly Report", marks: [] }]),
      newBlock("paragraph", [
        { text: "Revenue was ", marks: [] },
        { text: "up 12%", marks: ["bold"] },
        { text: " over ", marks: [] },
        { text: "last year", marks: ["italic", "underline"] },
        { text: ".", marks: [] },
      ]),
    ],
  };
}

test("JSON round-trip preserves the document exactly", () => {
  const d = sample();
  const restored = fromJSON(toJSON(d));
  assert.deepEqual(restored, d);
});

test("fromJSON rejects an unsupported schema version", () => {
  assert.throws(() => fromJSON(JSON.stringify({ schemaVersion: "9.9", blocks: [] })));
});

test("fromJSON rejects structurally invalid documents", () => {
  const bad = {
    schemaVersion: SCHEMA_VERSION,
    blocks: [{ id: "", type: "paragraph", runs: [] }],
  };
  assert.throws(() => fromJSON(JSON.stringify(bad)));
});

test("HTML export nests marks and escapes content", () => {
  const d: DocModel = {
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      newBlock("paragraph", [{ text: "a < b", marks: ["bold", "italic"] }]),
    ],
  };
  const html = toHTML(d);
  assert.ok(html.includes("<em><strong>a &lt; b</strong></em>"));
});

test("Markdown export is honest about underline loss", () => {
  const { markdown, report } = toMarkdown(sample());
  assert.ok(markdown.startsWith("# Quarterly Report"));
  assert.ok(markdown.includes("**up 12%**"));
  assert.equal(report.lossless, false);
  assert.equal(report.warnings[0]!.code, "MD-UNDERLINE-LOST");
});

test("Markdown export of plain text is lossless", () => {
  const d: DocModel = {
    schemaVersion: SCHEMA_VERSION,
    blocks: [newBlock("paragraph", [{ text: "plain", marks: [] }])],
  };
  assert.equal(toMarkdown(d).report.lossless, true);
});

test("inspector emits codes in document order with balanced mark pairs", () => {
  const codes = inspect(sample());
  const labels = codes.map((c) => c.label);
  assert.equal(labels[0], "[Heading 1]");
  const ons = codes.filter((c) => c.kind === "mark-on").length;
  const offs = codes.filter((c) => c.kind === "mark-off").length;
  assert.equal(ons, offs);
  // Bold turns on before "up 12%" and off right after it
  const boldOn = codes.find((c) => c.label === "[Bold On]")!;
  assert.equal(boldOn.blockIndex, 1);
  assert.equal(boldOn.start, "Revenue was ".length);
});

test("inspector text codes reconstruct the document text (no second source of truth)", () => {
  const d = sample();
  const codes = inspect(d);
  const rebuilt = d.blocks
    .map((_, bi) =>
      codes
        .filter((c) => c.kind === "text" && c.blockIndex === bi)
        .map((c) => c.label)
        .join("")
    )
    .join("\n");
  assert.equal(rebuilt, docText(d));
});

test("explainAt names the block type and active formatting", () => {
  const msg = explainAt(sample(), 1, "Revenue was u".length);
  assert.ok(msg.includes("Bold"));
  assert.ok(msg.includes("Para"));
});
