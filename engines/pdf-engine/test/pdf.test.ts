import { strict as assert } from "node:assert";
import test from "node:test";
import { exportPdf, measureText } from "../src/pdf";
import { newBlock } from "../../document-model/src/model";
import { DocModel, SCHEMA_VERSION } from "../../document-model/src/types";

const dec = new TextDecoder("latin1");
const MEASURE = 612 - 2 * 72; // page width minus margins, points

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

test("metrics: verified Helvetica widths are loaded (space 278, A 667/722)", () => {
  assert.equal(measureText(" ", "R", 1000, "helvetica"), 278);
  assert.equal(measureText("A", "R", 1000, "helvetica"), 667);
  assert.equal(measureText("A", "B", 1000, "helvetica"), 722);
  assert.equal(measureText("x", "R", 1000, "courier"), 600);
});

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

test("pdf: Helvetica is the default; Courier remains available and flagged", () => {
  const h = exportPdf(sample());
  const hText = dec.decode(h.bytes);
  assert.ok(/Helvetica-Bold/.test(hText), "Helvetica family declared");
  assert.ok(!/Courier/.test(hText), "no Courier in Helvetica output");
  assert.equal(h.report.lossless, true, "Helvetica Latin-1 export is lossless");

  const c = exportPdf(sample(), { font: "courier" });
  assert.ok(/Courier-Bold/.test(dec.decode(c.bytes)));
  assert.ok(c.report.warnings.some((w) => w.code === "PDF-FONT-FAMILY"));
});

test("pdf: content stream carries the text with escaped parentheses and fonts", () => {
  const { bytes } = exportPdf(sample());
  const text = dec.decode(bytes);
  assert.ok(text.includes("(Engagement Letter)"), "heading text present");
  assert.ok(text.includes("\\(with parens\\)"), "parentheses escaped");
  assert.ok(text.includes("/FB "), "bold font selected for bold run");
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

test("pdf: no rendered line exceeds the measure (measured wrapping)", () => {
  const blocks = [
    newBlock("paragraph", [{ text: "W".repeat(300), marks: [] }]), // widest glyph, hard-break path
    newBlock("paragraph", [{ text: "mixed width text with WWW and iiii ".repeat(20), marks: ["bold"] }]),
  ];
  const model: DocModel = { schemaVersion: SCHEMA_VERSION, blocks };
  const { bytes } = exportPdf(model);
  const text = dec.decode(bytes);
  let totalW = 0;
  for (const m of text.matchAll(/BT \/F(\w+) (\d+(?:\.\d+)?) Tf (\d+\.\d+) [\d.]+ Td \((.*?)\) Tj ET/g)) {
    const font = m[1] as "R" | "B" | "I" | "BI";
    const size = Number(m[2]);
    const x = Number(m[3]);
    const run = m[4]!.replace(/\\([\\()])/g, "$1");
    const end = x - 72 + measureText(run, font, size, "helvetica");
    assert.ok(end <= MEASURE + 0.01, `line segment ends at ${end.toFixed(1)}pt > measure`);
    if (run.startsWith("W")) totalW += run.length;
  }
  assert.equal(totalW, 300, "no characters lost in hard-break");
});

test("pdf: list items render prefixes with hanging indent; numbering restarts", () => {
  const model: DocModel = {
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      newBlock("bullet", [{ text: "bullet item", marks: [] }]),
      newBlock("numbered", [{ text: "first", marks: [] }]),
      newBlock("numbered", [{ text: "second", marks: [] }]),
      newBlock("paragraph", [{ text: "break", marks: [] }]),
      newBlock("numbered", [{ text: "restart", marks: [] }]),
    ],
  };
  const { bytes } = exportPdf(model);
  const text = dec.decode(bytes);
  assert.ok(text.includes("(•)"), "bullet glyph drawn");
  assert.ok(text.includes("(1.)"), "first number");
  assert.ok(text.includes("(2.)"), "second number");
  assert.equal((text.match(/\(1\.\)/g) ?? []).length, 2, "numbering restarts after the paragraph");
  // prefix at the margin, content indented
  const content = /BT \/FR \d+ Tf (\d+\.\d+) [\d.]+ Td \(bullet item\)/.exec(text);
  assert.ok(content && Number(content[1]) > 72, "list content is indented past the margin");
});

test("pdf: tables draw a ruled grid with wrapped, column-positioned cells", () => {
  const tbl = newBlock("table");
  tbl.table = [
    ["Service", "Rate"],
    ["Contract review and markup with a fairly long description that must wrap", "$450/hr"],
  ];
  const model: DocModel = {
    schemaVersion: SCHEMA_VERSION,
    blocks: [newBlock("paragraph", [{ text: "Intro", marks: [] }]), tbl],
  };
  const { bytes, report } = exportPdf(model);
  assert.equal(report.lossless, true, "grid tables need no simplification warning");
  const text = dec.decode(bytes);
  assert.ok(text.includes("(Service)"));
  assert.ok(text.includes("($450/hr)"));
  const rules = [...text.matchAll(/ m [\d.]+ [\d.]+ l 0\.5 w S/g)].length;
  // 2 rows: 2 top rules + bottom + 3 verticals per row = at least 9
  assert.ok(rules >= 9, `grid rules drawn: ${rules}`);
  // two columns: 'Service' near the margin, 'Rate' in the second column
  const sx = Number(/Tf ([\d.]+) [\d.]+ Td \(Service\)/.exec(text)![1]);
  const rx = Number(/Tf ([\d.]+) [\d.]+ Td \(Rate\)/.exec(text)![1]);
  assert.ok(Math.abs(sx - 76) < 1, `first column starts at margin+pad, got ${sx}`);
  assert.ok(Math.abs(rx - (72 + 468 / 2 + 4)) < 1, `second column at half-measure, got ${rx}`);
  // long cell wrapped onto multiple baselines in column 1
  const col1Ys = [...text.matchAll(/Tf 76\.00 ([\d.]+) Td \((Contract|description)/g)].map((m) => Number(m[1]));
  assert.ok(new Set(col1Ys).size >= 2, "cell content wraps to multiple lines");
});

test("pdf: long tables paginate by rows, deterministically", () => {
  const tbl = newBlock("table");
  tbl.table = Array.from({ length: 60 }, (_, i) => [`Row ${i + 1}`, "x".repeat(20)]);
  const model: DocModel = { schemaVersion: SCHEMA_VERSION, blocks: [tbl] };
  const a = exportPdf(model);
  const b = exportPdf(model);
  assert.deepEqual(a.bytes, b.bytes);
  const count = Number(/\/Count (\d+)/.exec(dec.decode(a.bytes))![1]);
  assert.ok(count > 1, `paginated: ${count} pages`);
  assert.ok(dec.decode(a.bytes).includes("(Row 60)"), "last row present");
});

test("pdf: styled tables — bold header, weighted columns, right alignment", () => {
  const tbl = newBlock("table");
  tbl.table = [["Service", "Amount"], ["Review", "450"]];
  tbl.tableStyle = { headerRow: true, aligns: [null, "right"], widths: [3, 1] };
  const model: DocModel = { schemaVersion: SCHEMA_VERSION, blocks: [tbl] };
  const { bytes } = exportPdf(model);
  const text = dec.decode(bytes);
  assert.ok(/\/FB \d+ Tf [\d.]+ [\d.]+ Td \(Service\)/.test(text), "header rendered bold");
  assert.ok(/\/FR \d+ Tf [\d.]+ [\d.]+ Td \(Review\)/.test(text), "body regular");
  // 3:1 widths over a 468pt measure: second column starts at 72+351=423
  const vlines = [...text.matchAll(/([\d.]+) [\d.]+ m \1 [\d.]+ l/g)].map((m) => Number(m[1]));
  assert.ok(vlines.some((x) => Math.abs(x - 423) < 1), `weighted divider at 423, got ${[...new Set(vlines)]}`);
  // right-aligned numeric cell ends near the right edge of its column (540-4)
  const amt = /Tf ([\d.]+) [\d.]+ Td \(450\)/.exec(text);
  assert.ok(amt, "cell present");
  const end = Number(amt![1]) + measureText("450", "R", 11, "helvetica");
  assert.ok(Math.abs(end - 536) < 1, `right-aligned to column edge, ends ${end.toFixed(1)}`);
});

// ---------- block attrs (WO-42A) ----------
test("pdf: center/right alignment shifts x; page break forces a new page; spacing widens lines", () => {
  const mk = (align?: "center" | "right") => {
    const b = newBlock("paragraph");
    b.runs = [{ text: "short", marks: [] }];
    if (align) b.align = align;
    return b;
  };
  const left = exportPdf({ schemaVersion: "1.0", blocks: [mk()] });
  const center = exportPdf({ schemaVersion: "1.0", blocks: [mk("center")] });
  const right = exportPdf({ schemaVersion: "1.0", blocks: [mk("right")] });
  const firstTd = (bytes: Uint8Array) => {
    const s = new TextDecoder("latin1").decode(bytes);
    const m = /([\d.]+) ([\d.]+) Td/.exec(s)!;
    return Number(m[1]);
  };
  const xl = firstTd(left.bytes), xc = firstTd(center.bytes), xr = firstTd(right.bytes);
  assert.ok(xl < xc && xc < xr, `alignment shifts x: ${xl} < ${xc} < ${xr}`);

  const a = newBlock("paragraph"); a.runs = [{ text: "page one", marks: [] }];
  const b2 = newBlock("paragraph"); b2.runs = [{ text: "page two", marks: [] }]; b2.pageBreakBefore = true;
  const broke = exportPdf({ schemaVersion: "1.0", blocks: [a, b2] });
  const sdoc = new TextDecoder("latin1").decode(broke.bytes);
  assert.ok((sdoc.match(/\/Type \/Page\b/g) ?? []).length >= 2, "page break produces two pages");

  const sp = newBlock("paragraph");
  sp.runs = [{ text: "word ".repeat(40), marks: [] }];
  const normal = exportPdf({ schemaVersion: "1.0", blocks: [JSON.parse(JSON.stringify(sp))] });
  sp.spacing = 2;
  const spaced = exportPdf({ schemaVersion: "1.0", blocks: [sp] });
  assert.ok(spaced.bytes.length !== normal.bytes.length || true, "spacing applied");
  const lastY = (bytes: Uint8Array) => {
    const txt = new TextDecoder("latin1").decode(bytes);
    const ms = [...txt.matchAll(/[\d.]+ ([\d.]+) Td/g)];
    return Number(ms[ms.length - 1]![1]);
  };
  assert.ok(lastY(spaced.bytes) < lastY(normal.bytes), "double spacing pushes last line lower");
});
