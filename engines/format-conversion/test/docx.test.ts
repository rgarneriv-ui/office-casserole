import { strict as assert } from "node:assert";
import test from "node:test";
import { JSDOM } from "jsdom";
import { crc32, zipRead, zipWrite } from "../src/zip";
import { exportDocx, importDocx } from "../src/docx";
import { newBlock } from "../../document-model/src/model";
import { DocModel, SCHEMA_VERSION } from "../../document-model/src/types";

const parseXml = (xml: string): Document =>
  new (new JSDOM("").window.DOMParser)().parseFromString(xml, "application/xml") as unknown as Document;

function sample(): DocModel {
  return {
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      newBlock("heading1", [{ text: "Engagement Letter", marks: [] }]),
      newBlock("paragraph", [
        { text: "This agreement is ", marks: [] },
        { text: "binding", marks: ["bold"] },
        { text: " and governed by ", marks: [] },
        { text: "North Carolina law", marks: ["italic", "underline"] },
        { text: ". Chars: <&\">", marks: [] },
      ]),
      newBlock("heading2", [{ text: "Scope", marks: [] }]),
      newBlock("paragraph", []),
      newBlock("paragraph", [{ text: "Services as described.", marks: [] }]),
    ],
  };
}

test("zip: round-trip with CRC validation", async () => {
  const entries = [
    { name: "a.txt", data: new TextEncoder().encode("hello hello hello hello") },
    { name: "dir/b.xml", data: new TextEncoder().encode("<x/>") },
  ];
  const bytes = await zipWrite(entries);
  assert.equal(bytes[0], 0x50); // 'P'
  assert.equal(bytes[1], 0x4b); // 'K'
  const back = await zipRead(bytes);
  assert.equal(back.length, 2);
  assert.equal(new TextDecoder().decode(back.find((e) => e.name === "a.txt")!.data), "hello hello hello hello");
  assert.equal(new TextDecoder().decode(back.find((e) => e.name === "dir/b.xml")!.data), "<x/>");
});

test("zip: corrupt data is rejected, not silently accepted", async () => {
  const bytes = await zipWrite([{ name: "a.txt", data: new TextEncoder().encode("abcdefgh") }]);
  // flip a byte inside the stored/deflated data region
  bytes[35] = bytes[35]! ^ 0xff;
  await assert.rejects(() => zipRead(bytes));
});

test("crc32 known vector", () => {
  // CRC-32 of "123456789" is 0xCBF43926
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("docx: export is a valid OOXML package shape", async () => {
  const { bytes, report } = await exportDocx(sample());
  assert.equal(report.lossless, true);
  const entries = await zipRead(bytes);
  const names = entries.map((e) => e.name).sort();
  assert.deepEqual(names, [
    "[Content_Types].xml",
    "_rels/.rels",
    "word/_rels/document.xml.rels",
    "word/document.xml",
    "word/numbering.xml",
    "word/styles.xml",
  ]);
  const doc = new TextDecoder().decode(entries.find((e) => e.name === "word/document.xml")!.data);
  assert.ok(doc.includes('<w:pStyle w:val="Heading1"/>'));
  assert.ok(doc.includes("&lt;&amp;&quot;&gt;")); // escaping
  assert.ok(doc.includes('<w:u w:val="single"/>'));
});

test("docx: export → import round-trip preserves content, structure, and marks", async () => {
  const original = sample();
  const { bytes } = await exportDocx(original);
  const { model, report } = await importDocx(bytes, parseXml);
  assert.equal(report.lossless, true, JSON.stringify(report.warnings));
  assert.equal(model.blocks.length, original.blocks.length);
  model.blocks.forEach((b, i) => {
    assert.equal(b.type, original.blocks[i]!.type, `block ${i} type`);
    assert.deepEqual(
      b.runs.map((r) => ({ text: r.text, marks: r.marks })),
      original.blocks[i]!.runs.map((r) => ({ text: r.text, marks: r.marks })),
      `block ${i} runs`
    );
  });
});

test("docx: import reports unsupported content instead of claiming fidelity", async () => {
  const docXml =
    `<?xml version="1.0"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    `<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>Deep heading</w:t></w:r></w:p>` +
    `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell text</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
    `<w:p><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>highlighted</w:t></w:r>` +
    `<w:r><w:drawing/></w:r></w:p>` +
    `<w:sectPr/></w:body></w:document>`;
  const bytes = await zipWrite([
    { name: "[Content_Types].xml", data: new TextEncoder().encode("<Types/>") },
    { name: "word/document.xml", data: new TextEncoder().encode(docXml) },
  ]);
  const { model, report } = await importDocx(bytes, parseXml);
  assert.equal(report.lossless, false);
  const codes = report.warnings.map((w) => w.code);
  assert.ok(codes.includes("DOCX-IMPORT-HEADING-LEVEL"));
  assert.ok(codes.includes("DOCX-IMPORT-RUN-PROP"));
  assert.ok(codes.includes("DOCX-IMPORT-RUN-CONTENT"));
  // content was kept, not dropped — table content now lands in a table block
  const text = model.blocks.map((b) => b.runs.map((r) => r.text).join("")).join("\n");
  assert.ok(text.includes("Deep heading"));
  assert.ok(text.includes("highlighted"));
  const tbl = model.blocks.find((b) => b.type === "table");
  assert.ok(tbl && tbl.table![0]![0] === "cell text", "table imported as a table block");
  assert.equal(model.blocks[0]!.type, "heading2");
});

test("docx: non-docx input fails loudly", async () => {
  await assert.rejects(() => importDocx(new TextEncoder().encode("not a zip at all"), parseXml));
  const bytes = await zipWrite([{ name: "readme.txt", data: new TextEncoder().encode("x") }]);
  await assert.rejects(() => importDocx(bytes, parseXml), /document\.xml missing/);
});

test("docx: lists round-trip through real OOXML numbering", async () => {
  const d: DocModel = {
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      newBlock("bullet", [{ text: "alpha", marks: [] }]),
      newBlock("bullet", [{ text: "beta", marks: [] }]),
      newBlock("numbered", [{ text: "one", marks: [] }]),
      newBlock("numbered", [{ text: "two", marks: ["italic"] }]),
      newBlock("paragraph", [{ text: "plain", marks: [] }]),
    ],
  };
  const { bytes, report } = await exportDocx(d);
  assert.equal(report.lossless, true);
  const entries = await zipRead(bytes);
  const numbering = new TextDecoder().decode(entries.find((e) => e.name === "word/numbering.xml")!.data);
  assert.ok(numbering.includes('<w:numFmt w:val="bullet"/>'));
  assert.ok(numbering.includes('<w:numFmt w:val="decimal"/>'));
  const docXml = new TextDecoder().decode(entries.find((e) => e.name === "word/document.xml")!.data);
  assert.ok(docXml.includes('<w:numId w:val="1"/>'), "bullet numId");
  assert.ok(docXml.includes('<w:numId w:val="2"/>'), "decimal numId");

  const { model, report: imp } = await importDocx(bytes, parseXml);
  assert.equal(imp.lossless, true, JSON.stringify(imp.warnings));
  assert.deepEqual(
    model.blocks.map((b) => b.type),
    ["bullet", "bullet", "numbered", "numbered", "paragraph"]
  );
  assert.deepEqual(model.blocks[3]!.runs[0]!.marks, ["italic"]);
});

test("docx: numPr without resolvable numbering imports as numbered with a warning", async () => {
  const docXml =
    `<?xml version="1.0"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="5"/><w:numId w:val="77"/></w:numPr></w:pPr>` +
    `<w:r><w:t>mystery item</w:t></w:r></w:p>` +
    `<w:sectPr/></w:body></w:document>`;
  const bytes = await zipWrite([
    { name: "[Content_Types].xml", data: new TextEncoder().encode("<Types/>") },
    { name: "word/document.xml", data: new TextEncoder().encode(docXml) },
  ]);
  const { model, report } = await importDocx(bytes, parseXml);
  assert.equal(model.blocks[0]!.type, "numbered");
  assert.equal(model.blocks[0]!.indent, 3, "deep level clamps to 3");
  const codes = report.warnings.map((w) => w.code);
  assert.ok(codes.includes("DOCX-IMPORT-NUMBERING"));
  assert.ok(codes.includes("DOCX-IMPORT-LIST-LEVEL"));
});

test("docx: tables export as w:tbl and round-trip as table blocks", async () => {
  const d: DocModel = { schemaVersion: SCHEMA_VERSION, blocks: [newBlock("paragraph", [{ text: "Intro", marks: [] }])] };
  const tbl = newBlock("table");
  tbl.table = [["Name", "Rate"], ["Rob", "$450"], ["Multi\nline", ""]];
  d.blocks.push(tbl);
  const { bytes, report } = await exportDocx(d);
  assert.equal(report.lossless, true);
  const entries = await zipRead(bytes);
  const docXml = new TextDecoder().decode(entries.find((e) => e.name === "word/document.xml")!.data);
  assert.ok(docXml.includes("<w:tbl>"));
  assert.ok(docXml.includes("<w:gridCol"));
  assert.ok((docXml.match(/<w:tr>/g) ?? []).length === 3, "three rows");

  const { model, report: imp } = await importDocx(bytes, parseXml);
  assert.equal(imp.lossless, true, JSON.stringify(imp.warnings));
  const back = model.blocks.find((b) => b.type === "table")!;
  assert.deepEqual(back.table, [["Name", "Rate"], ["Rob", "$450"], ["Multi\nline", ""]]);
});

test("docx: foreign tables with spans/formatting import with warnings, not flattening", async () => {
  const docXml =
    `<?xml version="1.0"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    `<w:tbl><w:tr>` +
    `<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Spanning bold</w:t></w:r></w:p></w:tc>` +
    `</w:tr><w:tr>` +
    `<w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc>` +
    `</w:tr></w:tbl>` +
    `<w:sectPr/></w:body></w:document>`;
  const bytes = await zipWrite([
    { name: "[Content_Types].xml", data: new TextEncoder().encode("<Types/>") },
    { name: "word/document.xml", data: new TextEncoder().encode(docXml) },
  ]);
  const { model, report } = await importDocx(bytes, parseXml);
  const tbl = model.blocks.find((b) => b.type === "table")!;
  assert.deepEqual(tbl.table, [["Spanning bold", ""], ["a", "b"]], "ragged rows padded rectangular");
  const codes = report.warnings.map((w) => w.code);
  assert.ok(codes.includes("DOCX-IMPORT-TABLE-SPAN"));
  assert.ok(codes.includes("DOCX-IMPORT-TABLE-FORMATTING"));
});

test("docx: nested lists round-trip ilvl and multi-level definitions", async () => {
  const d: DocModel = { schemaVersion: SCHEMA_VERSION, blocks: [
    newBlock("numbered", [{ text: "top", marks: [] }]),
    newBlock("numbered", [{ text: "sub", marks: [] }]),
    newBlock("bullet", [{ text: "deep bullet", marks: [] }]),
  ]};
  d.blocks[1]!.indent = 1;
  d.blocks[2]!.indent = 2;
  const { bytes } = await exportDocx(d);
  const entries = await zipRead(bytes);
  const docXml = new TextDecoder().decode(entries.find((e) => e.name === "word/document.xml")!.data);
  assert.ok(docXml.includes('<w:ilvl w:val="1"/>'));
  assert.ok(docXml.includes('<w:ilvl w:val="2"/>'));
  const numbering = new TextDecoder().decode(entries.find((e) => e.name === "word/numbering.xml")!.data);
  assert.ok(numbering.includes('w:val="lowerLetter"'), "level-1 alpha defined");
  assert.ok(numbering.includes('w:val="lowerRoman"'), "level-2 roman defined");
  const { model, report } = await importDocx(bytes, parseXml);
  assert.equal(report.lossless, true, JSON.stringify(report.warnings));
  assert.deepEqual(model.blocks.map((b) => [b.type, b.indent ?? 0]), [["numbered", 0], ["numbered", 1], ["bullet", 2]]);
});

test("docx: table style (header, widths, aligns) round-trips", async () => {
  const { insertTable, setTableCell, setTableStyle } = await import("../../document-model/src/operations.js");
  const d: DocModel = { schemaVersion: SCHEMA_VERSION, blocks: [newBlock("paragraph", [{ text: "Intro", marks: [] }])] };
  insertTable(d, { block: 0, offset: 5 }, 2, 3);
  setTableCell(d, 1, 0, 0, "Service");
  setTableCell(d, 1, 1, 2, "right-cell");
  setTableStyle(d, 1, { aligns: [null, "center", "right"], widths: [2, 1, 1] });
  const { bytes } = await exportDocx(d);
  const entries = await zipRead(bytes);
  const docXml = new TextDecoder().decode(entries.find((e) => e.name === "word/document.xml")!.data);
  assert.ok(docXml.includes("<w:tblHeader/>"), "header row marked");
  assert.ok(docXml.includes('<w:jc w:val="right"/>'), "alignment emitted");
  assert.ok(docXml.includes("<w:rPr><w:b/></w:rPr>"), "header runs bold");
  const widths = [...docXml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
  assert.equal(widths.length, 3);
  assert.ok(Math.abs(widths[0]! / widths[1]! - 2) < 0.05, `2:1:1 widths, got ${widths}`);

  const { model, report } = await importDocx(bytes, parseXml);
  assert.equal(report.lossless, true, JSON.stringify(report.warnings));
  const tbl = model.blocks.find((b) => b.type === "table")!;
  assert.equal(tbl.tableStyle?.headerRow, true);
  assert.deepEqual(tbl.tableStyle?.aligns, [null, "center", "right"]);
  assert.ok(tbl.tableStyle?.widths && Math.abs(tbl.tableStyle.widths[0]! / tbl.tableStyle.widths[1]! - 2) < 0.1);
});
