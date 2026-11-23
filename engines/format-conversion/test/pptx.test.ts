import { strict as assert } from "node:assert";
import test from "node:test";
import { exportPptx } from "../src/pptx";
import { zipRead } from "../src/zip";
import {
  addSlide,
  newDeck,
  rectElement,
  textElement,
  addElement,
  updateElement,
} from "../../presentation-model/src/model";

function sampleDeck() {
  const deck = newDeck();
  updateElement(deck, 0, deck.slides[0]!.elements[0]!.id, { text: "Casserole Pitch" });
  addSlide(deck, 0);
  addElement(deck, 1, rectElement({ x: 100, y: 600, w: 400, h: 200, fill: "#ff8800" }));
  addElement(
    deck,
    1,
    textElement({ x: 120, y: 620, w: 360, h: 160, text: "Line one\nLine <two> & more", size: 30, align: "center" })
  );
  return deck;
}

test("pptx: package has every required part and relationship", async () => {
  const { bytes, report } = await exportPptx(sampleDeck());
  assert.equal(report.lossless, true);
  const entries = await zipRead(bytes);
  const names = entries.map((e) => e.name);
  for (const required of [
    "[Content_Types].xml",
    "_rels/.rels",
    "ppt/presentation.xml",
    "ppt/_rels/presentation.xml.rels",
    "ppt/slideMasters/slideMaster1.xml",
    "ppt/slideLayouts/slideLayout1.xml",
    "ppt/theme/theme1.xml",
    "ppt/slides/slide1.xml",
    "ppt/slides/slide2.xml",
    "ppt/slides/_rels/slide2.xml.rels",
  ]) {
    assert.ok(names.includes(required), `missing ${required}`);
  }
  const ct = new TextDecoder().decode(entries.find((e) => e.name === "[Content_Types].xml")!.data);
  assert.ok(ct.includes("/ppt/slides/slide2.xml"), "content types list every slide");
});

test("pptx: shapes carry geometry in EMU and escaped multi-paragraph text", async () => {
  const { bytes } = await exportPptx(sampleDeck());
  const entries = await zipRead(bytes);
  const slide2 = new TextDecoder().decode(entries.find((e) => e.name === "ppt/slides/slide2.xml")!.data);
  // rect at x=100 logical → 762000 EMU; fill color
  assert.ok(slide2.includes('<a:off x="762000" y="4572000"/>'), "EMU offset");
  assert.ok(slide2.includes('<a:srgbClr val="FF8800"/>'), "rect fill");
  // text: two paragraphs, escaped, centered, sized 30*0.6*100=1800
  assert.ok(slide2.includes("<a:t>Line one</a:t>"));
  assert.ok(slide2.includes("<a:t>Line &lt;two&gt; &amp; more</a:t>"), "escaping");
  assert.ok(slide2.includes('algn="ctr"'), "alignment");
  assert.ok(slide2.includes('sz="1800"'), "font size conversion");
});

test("pptx: deterministic output for identical decks", async () => {
  const deck = sampleDeck();
  const a = await exportPptx(deck);
  const b = await exportPptx(deck);
  assert.deepEqual(a.bytes, b.bytes);
});

// ---------- import ----------
import { importPptx } from "../src/pptx";
import { JSDOM } from "jsdom";

const parseXml = (xml: string): Document =>
  new (new JSDOM("").window.DOMParser)().parseFromString(xml, "application/xml") as unknown as Document;

test("pptx: export → import round-trip preserves slides, geometry, text, and style", async () => {
  const original = sampleDeck();
  const { bytes } = await exportPptx(original);
  const { deck, report } = await importPptx(bytes, parseXml);
  assert.equal(report.lossless, true, JSON.stringify(report.warnings));
  assert.equal(deck.slides.length, original.slides.length);
  original.slides.forEach((slide, si) => {
    const back = deck.slides[si]!;
    assert.equal(back.elements.length, slide.elements.length, `slide ${si} element count`);
    slide.elements.forEach((el, ei) => {
      const b = back.elements[ei]!;
      assert.equal(b.kind, el.kind, `slide ${si} el ${ei} kind`);
      assert.ok(Math.abs(b.x - el.x) < 1 && Math.abs(b.y - el.y) < 1, "geometry x/y");
      assert.ok(Math.abs(b.w - el.w) < 1 && Math.abs(b.h - el.h) < 1, "geometry w/h");
      if (el.kind === "text") {
        assert.equal(b.text, el.text, "text");
        assert.equal(b.bold ?? false, el.bold ?? false, "bold");
        assert.equal(b.align ?? "left", el.align ?? "left", "align");
        assert.ok(Math.abs((b.size ?? 36) - (el.size ?? 36)) <= 1, "size");
      } else {
        assert.equal((b.fill ?? "").toLowerCase(), (el.fill ?? "").toLowerCase(), "fill");
      }
    });
  });
});

test("pptx: import reports pictures, frames, groups, and missing geometry", async () => {
  const slide =
    `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>` +
    `<p:nvGrpSpPr/><p:grpSpPr/>` +
    `<p:sp><p:nvSpPr/><p:spPr/><p:txBody><a:p><a:r><a:t>Placeholder title</a:t></a:r></a:p></p:txBody></p:sp>` +
    `<p:pic/><p:graphicFrame/><p:grpSp/>` +
    `</p:spTree></p:cSld></p:sld>`;
  const bytes = await zipWriteHelper([
    ["ppt/presentation.xml", `<p:presentation xmlns:p="x"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`],
    ["ppt/slides/slide1.xml", slide],
  ]);
  const { deck, report } = await importPptx(bytes, parseXml);
  assert.equal(deck.slides.length, 1);
  // text shape + the broken picture's placeholder rect
  assert.equal(deck.slides[0]!.elements.length, 2);
  assert.equal(deck.slides[0]!.elements[0]!.text, "Placeholder title");
  const codes = report.warnings.map((w) => w.code);
  for (const expected of ["PPTX-IMPORT-NO-GEOMETRY", "PPTX-IMPORT-PICTURE-MISSING", "PPTX-IMPORT-GRAPHIC", "PPTX-IMPORT-GROUP"]) {
    assert.ok(codes.includes(expected), `missing ${expected} in ${codes}`);
  }
});

test("pptx: 4:3 decks are scaled per axis with a warning", async () => {
  const slide =
    `<p:sld xmlns:p="x" xmlns:a="y"><p:cSld><p:spTree>` +
    `<p:sp><p:spPr><a:xfrm><a:off x="4572000" y="3429000"/><a:ext cx="4572000" cy="1714500"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:p><a:r><a:t>center</a:t></a:r></a:p></p:txBody></p:sp>` +
    `</p:spTree></p:cSld></p:sld>`;
  // 4:3 deck: 9144000 x 6858000
  const bytes = await zipWriteHelper([
    ["ppt/presentation.xml", `<p:presentation xmlns:p="x"><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`],
    ["ppt/slides/slide1.xml", slide],
  ]);
  const { deck, report } = await importPptx(bytes, parseXml);
  assert.ok(report.warnings.some((w) => w.code === "PPTX-IMPORT-ASPECT"));
  const el = deck.slides[0]!.elements[0]!;
  assert.equal(Math.round(el.x), 800); // half of 1600
  assert.equal(Math.round(el.y), 450); // half of 900
});

test("pptx: non-pptx input fails loudly", async () => {
  await assert.rejects(() => importPptx(new TextEncoder().encode("nope"), parseXml));
});

async function zipWriteHelper(parts: [string, string][]) {
  const { zipWrite } = await import("../src/zip.js");
  return zipWrite(parts.map(([name, xml]) => ({ name, data: new TextEncoder().encode(xml) })));
}

// 1x1 red PNG
const RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("pptx: images embed as media parts and round-trip to data URLs", async () => {
  const { imageElement, newDeck: nd, addElement: ae } = await import("../../presentation-model/src/model.js");
  const deck = nd();
  ae(deck, 0, imageElement(`data:image/png;base64,${RED_PNG}`, { x: 200, y: 150, w: 400, h: 300 }));
  const { bytes, report } = await exportPptx(deck);
  assert.equal(report.lossless, true);
  const entries = await zipRead(bytes);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("ppt/media/image1.png"), names.join(","));
  const slide1 = new TextDecoder().decode(entries.find((e) => e.name === "ppt/slides/slide1.xml")!.data);
  assert.ok(slide1.includes("<p:pic>"), "picture shape emitted");
  assert.ok(slide1.includes('r:embed="rIdImg1"'));
  const rels = new TextDecoder().decode(entries.find((e) => e.name === "ppt/slides/_rels/slide1.xml.rels")!.data);
  assert.ok(rels.includes("../media/image1.png"));
  const ct = new TextDecoder().decode(entries.find((e) => e.name === "[Content_Types].xml")!.data);
  assert.ok(ct.includes('Extension="png"'));

  const { deck: back, report: imp } = await importPptx(bytes, parseXml);
  assert.equal(imp.lossless, true, JSON.stringify(imp.warnings));
  const img = back.slides[0]!.elements.find((e) => e.kind === "image")!;
  assert.ok(img, "image element imported");
  assert.equal(img.src, `data:image/png;base64,${RED_PNG}`, "media bytes round-trip exactly");
  assert.ok(Math.abs(img.x - 200) < 1 && Math.abs(img.w - 400) < 1, "geometry preserved");
});

test("pptx: a picture with missing media imports as a placeholder with a warning", async () => {
  const slide =
    `<p:sld xmlns:p="x" xmlns:a="y" xmlns:r="z"><p:cSld><p:spTree>` +
    `<p:pic><p:blipFill><a:blip r:embed="rId9"/></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="762000" y="762000"/><a:ext cx="1524000" cy="1524000"/></a:xfrm></p:spPr></p:pic>` +
    `</p:spTree></p:cSld></p:sld>`;
  const bytes = await zipWriteHelper([
    ["ppt/presentation.xml", `<p:presentation xmlns:p="x"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`],
    ["ppt/slides/slide1.xml", slide],
  ]);
  const { deck, report } = await importPptx(bytes, parseXml);
  assert.ok(report.warnings.some((w) => w.code === "PPTX-IMPORT-PICTURE-MISSING"));
  assert.equal(deck.slides[0]!.elements[0]!.kind, "rect", "footprint kept as placeholder");
});

test("pptx: ellipse shapes and z-order round-trip", async () => {
  const m = await import("../../presentation-model/src/model.js");
  const deck = m.newDeck();
  const back = m.rectElement({ x: 100, y: 100, w: 600, h: 400, fill: "#112233" });
  const front = m.rectElement({ x: 200, y: 200, w: 300, h: 300, fill: "#445566" });
  front.shape = "ellipse";
  m.addElement(deck, 0, back);
  m.addElement(deck, 0, front);
  m.reorderElement(deck, 0, back.id, "front"); // back now draws on top
  assert.equal(deck.slides[0]!.elements[deck.slides[0]!.elements.length - 1]!.id, back.id);

  const { bytes } = await exportPptx(deck);
  const entries = await zipRead(bytes);
  const slide1 = new TextDecoder().decode(entries.find((e) => e.name === "ppt/slides/slide1.xml")!.data);
  assert.ok(slide1.includes('prst="ellipse"'), "ellipse geometry emitted");
  // order in the spTree mirrors z-order: ellipse (445566) before the fronted rect (112233)
  assert.ok(slide1.indexOf("445566") < slide1.indexOf("112233"), "z-order preserved in XML");

  const { deck: imported, report } = await importPptx(bytes, parseXml);
  assert.equal(report.lossless, true, JSON.stringify(report.warnings));
  const shapes = imported.slides[0]!.elements.filter((e) => e.kind === "rect");
  assert.equal(shapes.find((e) => e.fill === "#445566")?.shape, "ellipse", "ellipse imported");
  assert.equal(shapes.find((e) => e.fill === "#112233")?.shape, undefined, "plain rect has no shape variant");
});

// ---------- lines/connectors (WO-35) ----------
import { lineElement } from "../../presentation-model/src/model";

test("pptx: lines round-trip as connectors (geometry, direction, stroke, arrow)", async () => {
  const deck = newDeck();
  deck.slides[0]!.elements.push(
    lineElement({ x: 200, y: 150, w: 600, h: 300, stroke: "#aa2222", strokeWidth: 6, arrow: true }),
    lineElement({ x: 900, y: 150, w: 400, h: 250, dir: "up" })
  );
  const out = await exportPptx(deck);
  const back = await importPptx(out.bytes, parseXml);
  const lines = back.deck.slides[0]!.elements.filter((e) => e.kind === "line");
  assert.equal(lines.length, 2);
  const [a, b] = lines;
  assert.equal(a!.dir, "down");
  assert.equal(a!.stroke, "#aa2222");
  assert.equal(a!.strokeWidth, 6);
  assert.equal(a!.arrow, true);
  assert.ok(Math.abs(a!.x - 200) <= 1 && Math.abs(a!.w - 600) <= 1, `geometry survives: x=${a!.x} w=${a!.w}`);
  assert.equal(b!.dir, "up", "flipV maps to dir up");
  assert.ok(!b!.arrow);
});
