import { strict as assert } from "node:assert";
import test from "node:test";
import { JSDOM } from "jsdom";
import { exportXlsx, importXlsx } from "../src/xlsx";
import { zipRead, zipWrite } from "../src/zip";
import { Sheet } from "../../spreadsheet-calc/src/engine";
import { isError } from "../../spreadsheet-calc/src/types";

const parseXml = (xml: string): Document =>
  new (new JSDOM("").window.DOMParser)().parseFromString(xml, "application/xml") as unknown as Document;

function sample(): Sheet {
  const s = new Sheet();
  s.setCell("A1", "Item");
  s.setCell("B1", "Qty");
  s.setCell("C1", "Unit");
  s.setCell("A2", "Paper");
  s.setCell("B2", "12");
  s.setCell("C2", "4.5");
  s.setCell("D2", "=B2*C2");
  s.setCell("A3", "Done?");
  s.setCell("B3", "TRUE");
  s.setCell("D4", "=SUM(D2:D3)");
  s.setCell("D5", '=IF(D4>50, "big", "small")');
  s.setCell("E1", "=1/0");
  return s;
}

test("xlsx: export package shape and cell encodings", async () => {
  const { bytes, report } = await exportXlsx(sample());
  assert.equal(report.lossless, true);
  const entries = await zipRead(bytes);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("xl/workbook.xml"));
  assert.ok(names.includes("xl/worksheets/sheet1.xml"));
  assert.ok(names.includes("xl/styles.xml"));
  const ws = new TextDecoder().decode(entries.find((e) => e.name === "xl/worksheets/sheet1.xml")!.data);
  assert.ok(ws.includes('<c r="A1" t="inlineStr"><is><t xml:space="preserve">Item</t></is></c>'), "inline string");
  assert.ok(ws.includes('<c r="B2"><v>12</v></c>'), "number");
  assert.ok(ws.includes('<c r="D2"><f>B2*C2</f><v>54</v></c>'), "formula with computed value");
  assert.ok(ws.includes('<c r="B3" t="b"><v>1</v></c>'), "boolean");
  assert.ok(ws.includes('<c r="E1" t="e"><f>1/0</f><v>#DIV/0!</v></c>'), "error cell");
  assert.ok(ws.includes('t="str"'), "string formula result typed str");
});

test("xlsx: export → import round-trip preserves inputs and recomputes identically", async () => {
  const original = sample();
  const { bytes } = await exportXlsx(original);
  const { sheet, report } = await importXlsx(bytes, parseXml);
  assert.equal(report.lossless, true, JSON.stringify(report.warnings));
  for (const { addr, input } of original.entries()) {
    assert.equal(sheet.getInput(addr), input, `input of ${addr}`);
    assert.equal(sheet.getDisplay(addr), original.getDisplay(addr), `display of ${addr}`);
  }
});

test("xlsx: import reads sharedStrings-style producers", async () => {
  const sst =
    `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">` +
    `<si><t>Hello</t></si><si><r><t>Wor</t></r><r><t>ld</t></r></si></sst>`;
  const ws =
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v>7</v></c></row>` +
    `</sheetData></worksheet>`;
  const bytes = await zipWrite([
    { name: "xl/workbook.xml", data: new TextEncoder().encode(`<workbook xmlns="x"><sheets><sheet name="S" sheetId="1"/></sheets></workbook>`) },
    { name: "xl/sharedStrings.xml", data: new TextEncoder().encode(sst) },
    { name: "xl/worksheets/sheet1.xml", data: new TextEncoder().encode(ws) },
  ]);
  const { sheet } = await importXlsx(bytes, parseXml);
  assert.equal(sheet.getCell("A1"), "Hello");
  assert.equal(sheet.getCell("B1"), "World");
  assert.equal(sheet.getCell("C1"), 7);
});

test("xlsx: value mismatches and unsupported functions are reported, not hidden", async () => {
  const ws =
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row r="1"><c r="A1"><v>10</v></c>` +
    `<c r="B1"><f>A1*2</f><v>999</v></c>` + // wrong stored value
    `<c r="C1"><f>VLOOKUP(A1,D1:E9,2)</f><v>42</v></c>` + // unsupported function
    `</row></sheetData></worksheet>`;
  const bytes = await zipWrite([
    { name: "xl/workbook.xml", data: new TextEncoder().encode(`<workbook xmlns="x"><sheets><sheet name="S" sheetId="1"/></sheets></workbook>`) },
    { name: "xl/worksheets/sheet1.xml", data: new TextEncoder().encode(ws) },
  ]);
  const { sheet, report } = await importXlsx(bytes, parseXml);
  assert.equal(sheet.getCell("B1"), 20, "our engine recomputes honestly");
  const codes = report.warnings.map((w) => w.code);
  assert.ok(codes.includes("XLSX-IMPORT-VALUE-MISMATCH"), JSON.stringify(codes));
  assert.ok(codes.includes("XLSX-IMPORT-FORMULA-UNSUPPORTED"));
  const c1 = sheet.getCell("C1");
  assert.ok(isError(c1) && c1.code === "#NAME?", "unsupported function surfaces as #NAME?");
});

test("xlsx: multi-sheet workbooks import the first sheet with a warning", async () => {
  const wb = `<workbook xmlns="x"><sheets><sheet name="A" sheetId="1"/><sheet name="B" sheetId="2"/></sheets></workbook>`;
  const ws = `<worksheet xmlns="x"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`;
  const bytes = await zipWrite([
    { name: "xl/workbook.xml", data: new TextEncoder().encode(wb) },
    { name: "xl/worksheets/sheet1.xml", data: new TextEncoder().encode(ws) },
    { name: "xl/worksheets/sheet2.xml", data: new TextEncoder().encode(ws) },
  ]);
  const { report } = await importXlsx(bytes, parseXml);
  assert.ok(report.warnings.some((w) => w.code === "XLSX-IMPORT-SHEETS"));
});

test("xlsx: non-xlsx input fails loudly", async () => {
  await assert.rejects(() => importXlsx(new TextEncoder().encode("junk"), parseXml));
  const bytes = await zipWrite([{ name: "word/document.xml", data: new TextEncoder().encode("<x/>") }]);
  await assert.rejects(() => importXlsx(bytes, parseXml), /workbook\.xml missing/);
});

test("xlsx: cell formats export as real styles (s attrs + styleSheet)", async () => {
  const s = new Sheet();
  s.setCell("A1", "Total");
  s.setFormat("A1", { bold: true });
  s.setCell("B1", "1234.5");
  s.setFormat("B1", { numFmt: "currency", bold: true });
  s.setCell("C1", "0.125");
  s.setFormat("C1", { numFmt: "percent" });
  const { bytes } = await exportXlsx(s);
  const entries = await zipRead(bytes);
  const styles = new TextDecoder().decode(entries.find((e) => e.name === "xl/styles.xml")!.data);
  assert.ok(styles.includes('formatCode="0.00%"'));
  assert.ok(styles.includes("<b/>"), "bold font present");
  const ws = new TextDecoder().decode(entries.find((e) => e.name === "xl/worksheets/sheet1.xml")!.data);
  assert.ok(/<c r="A1" s="\d+" t="inlineStr">/.test(ws), "bold text cell carries a style");
  assert.ok(/<c r="B1" s="\d+">/.test(ws), "currency cell carries a style");
  // importing our styled export round-trips the formats losslessly
  const { sheet, report } = await importXlsx(bytes, parseXml);
  assert.equal(report.lossless, true, JSON.stringify(report.warnings));
  assert.equal(sheet.getCell("B1"), 1234.5);
  assert.deepEqual(sheet.getFormat("A1"), { bold: true });
  assert.deepEqual(sheet.getFormat("B1"), { bold: true, numFmt: "currency" });
  assert.deepEqual(sheet.getFormat("C1"), { numFmt: "percent" });
  assert.equal(sheet.getDisplay("B1"), "$1,234.50", "display formatting restored");
});

test("xlsx: foreign styles map by heuristic; unrepresentable aspects warn once", async () => {
  const styles =
    `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="1"><numFmt numFmtId="170" formatCode="0.0%"/></numFmts>` +
    `<fonts count="2"><font/><font><b/><i/></font></fonts>` +
    `<cellXfs count="3">` +
    `<xf numFmtId="0" fontId="0"/>` +
    `<xf numFmtId="170" fontId="0"><alignment horizontal="center"/></xf>` +
    `<xf numFmtId="9" fontId="1" borderId="1"/>` +
    `</cellXfs></styleSheet>`;
  const ws =
    `<worksheet xmlns="x"><sheetData><row r="1">` +
    `<c r="A1" s="1"><v>0.5</v></c>` +
    `<c r="B1" s="2"><v>0.25</v></c>` +
    `</row></sheetData></worksheet>`;
  const bytes = await zipWrite([
    { name: "xl/workbook.xml", data: new TextEncoder().encode(`<workbook xmlns="x"><sheets><sheet name="S" sheetId="1"/></sheets></workbook>`) },
    { name: "xl/styles.xml", data: new TextEncoder().encode(styles) },
    { name: "xl/worksheets/sheet1.xml", data: new TextEncoder().encode(ws) },
  ]);
  const { sheet, report } = await importXlsx(bytes, parseXml);
  assert.deepEqual(sheet.getFormat("A1"), { numFmt: "percent", align: "center" }, "custom % code classified");
  assert.deepEqual(sheet.getFormat("B1"), { bold: true, numFmt: "percent" }, "builtin 9 + bold");
  const styleWarnings = report.warnings.filter((w) => w.code === "XLSX-IMPORT-STYLES");
  assert.equal(styleWarnings.length, 1, "one summary warning");
  assert.ok(styleWarnings[0]!.message.includes("font i"), styleWarnings[0]!.message);
  assert.ok(styleWarnings[0]!.message.includes("border"));
});

test("xlsx: column widths round-trip through <cols>", async () => {
  const s = new Sheet();
  s.setCell("A1", "wide column");
  s.setColWidth(0, 32.5);
  s.setColWidth(3, 14);
  const { bytes } = await exportXlsx(s);
  const entries = await zipRead(bytes);
  const ws = new TextDecoder().decode(entries.find((e) => e.name === "xl/worksheets/sheet1.xml")!.data);
  assert.ok(ws.includes('<col min="1" max="1" width="32.5" customWidth="1"/>'), ws.slice(0, 400));
  const { sheet } = await importXlsx(bytes, parseXml);
  assert.equal(sheet.getColWidth(0), 32.5);
  assert.equal(sheet.getColWidth(3), 14);
  assert.equal(sheet.getColWidth(1), undefined);
});
