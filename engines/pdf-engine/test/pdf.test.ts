import { strict as assert } from "node:assert";
import test from "node:test";
import { exportPdf } from "../src/pdf";
import { newBlock } from "../../document-model/src/model";
import { DocModel, SCHEMA_VERSION } from "../../document-model/src/types";

const dec = new TextDecoder("latin1");

function sample(): DocModel {
  return {
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      newBlock("heading1", [{ text: "Engagement Letter", marks: [] }]),
      newBlock("paragraph", [
        { text: "This agreement (with parens) is ", marks: [] },
        { text: "binding", marks: ["bold"] },
        { text: " and ", marks: [] },
        { text: "underlined", marks: ["underline"] },
        { text: ".", marks: [] },
      ]),
    ],
  };
}

test("pdf: header, EOF, and parsable xref with correct object offsets", () => {
  const { bytes } = exportPdf(sample());
  const text = dec.decode(bytes);
  assert.ok(text.startsWith("%PDF-1.4"), "PDF header");
  assert.ok(text.trimEnd().endsWith("%%EOF"), "EOF marker");

  const startxref = Number(/startxref\n(\d+)\n/.exec(text)![1]);
  assert.equal(text.slice(startxref, startxref + 4), "xref", "startxref points at xref table");

  const xrefBody = text.slice(startxref);
  const entries = [...xrefBody.matchAll(/^(\d{10}) 00000 n /gm)].map((m) => Number(m[1]));
  assert.ok(entries.length >= 7, "xref lists all objects");
  entries.forEach((off, i) => {
    assert.ok(
      new RegExp(`^${i + 1} 0 obj`).test(text.slice(off, off + 12)),
      `xref entry ${i + 1} points at its object (offset ${off})`
    );
  });
});

test("pdf: content stream carries the text with escaped parentheses and fonts", () => {
  const { bytes } = exportPdf(sample());
  const text = dec.decode(bytes);
  assert.ok(text.includes("(Engagement Letter)"), "heading text present");
  assert.ok(text.includes("\\(with parens\\)"), "parentheses escaped");
  assert.ok(text.includes("/FB "), "bold font selected for bold run");
  assert.ok(/Courier-Bold/.test(text), "bold font declared");
  assert.ok(/ l 0\.5 w S/.test(text), "underline drawn as a line");
});

test("pdf: long documents paginate deterministically", () => {
  const blocks = [newBlock("heading1", [{ text: "Long document", marks: [] }])];
  for (let i = 0; i < 80; i++) {
    blocks.push(
      newBlock("paragraph", [
        { text: `Paragraph ${i + 1}: ` + "word ".repeat(30), marks: [] },
      ])
    );
  }
  const model: DocModel = { schemaVersion: SCHEMA_VERSION, blocks };
  const a = exportPdf(model);
  const b = exportPdf(model);
  assert.deepEqual(a.bytes, b.bytes, "identical input → identical bytes (deterministic)");
  const count = Number(/\/Count (\d+)/.exec(dec.decode(a.bytes))![1]);
  assert.ok(count > 1, `multi-page output, got ${count} page(s)`);
});

test("pdf: non-Latin text is replaced and reported, never silently mangled", () => {
  const model: DocModel = {
    schemaVersion: SCHEMA_VERSION,
    blocks: [newBlock("paragraph", [{ text: "Héllo 世界", marks: [] }])],
  };
  const { bytes, report } = exportPdf(model);
  const text = dec.decode(bytes);
  assert.ok(text.includes("(H\xe9llo ??)"), "Latin-1 kept, CJK replaced");
  assert.ok(report.warnings.some((w) => w.code === "PDF-CHARSET"), "charset loss reported");
  assert.equal(report.lossless, false);
});

test("pdf: over-long words hard-break instead of overflowing the margin", () => {
  const model: DocModel = {
    schemaVersion: SCHEMA_VERSION,
    blocks: [newBlock("paragraph", [{ text: "x".repeat(300), marks: [] }])],
  };
  const { bytes } = exportPdf(model);
  const text = dec.decode(bytes);
  const runs = [...text.matchAll(/\((x+)\)/g)].map((m) => m[1]!.length);
  assert.ok(runs.length > 1, "word was broken across lines");
  // 11pt Courier: floor(468 / 6.6) = 70 chars per line maximum
  assert.ok(Math.max(...runs) <= 70, `no line exceeds the measure, max ${Math.max(...runs)}`);
  assert.equal(runs.reduce((a, b) => a + b, 0), 300, "no characters lost");
});
