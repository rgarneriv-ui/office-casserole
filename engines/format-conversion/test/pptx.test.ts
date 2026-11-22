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
