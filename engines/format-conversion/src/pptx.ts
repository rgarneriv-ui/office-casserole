/**
 * PPTX (PresentationML) export for the presentation model — spec §5.2, §8.
 * Emits a minimal but complete package: presentation + slides + one blank
 * slide master/layout + theme. Elements export as real shapes with real text
 * runs (§8.2 — never flattened images). Geometry maps the 1600×900 logical
 * canvas onto a 16:9 slide (12192000×6858000 EMU), so EMU_PER_UNIT = 7620
 * and font sizes convert at 0.6 pt per logical unit (540pt slide height).
 */

import { DeckModel, Slide, SlideElement } from "../../presentation-model/src/model";
import { LossReport } from "../../document-model/src/serialize";
import { ZipEntry, zipWrite } from "./zip";

const textEncoder = new TextEncoder();

const EMU_PER_UNIT = 7620;
const PT_PER_UNIT = 0.6;
const SLIDE_CX = 12192000;
const SLIDE_CY = 6858000;

const NS_P = `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
const NS_A = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`;
const NS_R = `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hex6(color: string | undefined, fallback: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(color ?? "");
  return (m ? m[1]! : fallback).toUpperCase();
}

// ---------- shapes ----------

function shapeXml(el: SlideElement, index: number): string {
  const off = `<a:off x="${Math.round(el.x * EMU_PER_UNIT)}" y="${Math.round(el.y * EMU_PER_UNIT)}"/>`;
  const ext = `<a:ext cx="${Math.round(el.w * EMU_PER_UNIT)}" cy="${Math.round(el.h * EMU_PER_UNIT)}"/>`;
  const xfrm = `<a:xfrm>${off}${ext}</a:xfrm>`;
  const geom = `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`;

  if (el.kind === "rect") {
    return (
      `<p:sp><p:nvSpPr><p:cNvPr id="${index + 2}" name="Box ${index + 1}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr>${xfrm}${geom}<a:solidFill><a:srgbClr val="${hex6(el.fill, "DBE7F0")}"/></a:solidFill></p:spPr>` +
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>` +
      `</p:sp>`
    );
  }

  const algn = el.align === "center" ? "ctr" : el.align === "right" ? "r" : "l";
  const sz = Math.max(100, Math.round((el.size ?? 36) * PT_PER_UNIT * 100));
  const bold = el.bold ? ` b="1"` : "";
  const color = hex6(el.color, "222222");
  const lines = (el.text ?? "").split("\n");
  const paragraphs = lines
    .map((line) => {
      const run =
        line.length > 0
          ? `<a:r><a:rPr lang="en-US" sz="${sz}"${bold} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${xmlEscape(line)}</a:t></a:r>`
          : `<a:endParaRPr lang="en-US" sz="${sz}"${bold}/>`;
      return `<a:p><a:pPr algn="${algn}"/>${run}</a:p>`;
    })
    .join("");

  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${index + 2}" name="TextBox ${index + 1}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm}${geom}<a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" rtlCol="0"/><a:lstStyle/>${paragraphs}</p:txBody>` +
    `</p:sp>`
  );
}

function slideXml(slide: Slide): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:sld ${NS_P} ${NS_A} ${NS_R}><p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    slide.elements.map(shapeXml).join("") +
    `</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sld>`
  );
}

// ---------- fixed package parts ----------

const CLR_MAP = `bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"`;

const SLIDE_MASTER =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<p:sldMaster ${NS_P} ${NS_A} ${NS_R}><p:cSld><p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
  `</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/>` +
  `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
  `</p:sldMaster>`;

const SLIDE_LAYOUT =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<p:sldLayout ${NS_P} ${NS_A} ${NS_R} type="blank"><p:cSld name="Blank"><p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
  `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const THEME = (() => {
  const fill = (shade: string) =>
    `<a:solidFill><a:schemeClr val="phClr">${shade}</a:schemeClr></a:solidFill>`;
  const ln = (w: number) =>
    `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>`;
  const effect = `<a:effectStyle><a:effectLst/></a:effectStyle>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<a:theme ${NS_A} name="Casserole"><a:themeElements>` +
    `<a:clrScheme name="Casserole">` +
    `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
    `<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
    `<a:dk2><a:srgbClr val="26222E"/></a:dk2><a:lt2><a:srgbClr val="EFEEF4"/></a:lt2>` +
    `<a:accent1><a:srgbClr val="6B4B9E"/></a:accent1><a:accent2><a:srgbClr val="B4552D"/></a:accent2>` +
    `<a:accent3><a:srgbClr val="3C6E47"/></a:accent3><a:accent4><a:srgbClr val="2D6CB4"/></a:accent4>` +
    `<a:accent5><a:srgbClr val="B42D6C"/></a:accent5><a:accent6><a:srgbClr val="6CB42D"/></a:accent6>` +
    `<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>` +
    `</a:clrScheme>` +
    `<a:fontScheme name="Casserole">` +
    `<a:majorFont><a:latin typeface="Avenir Next"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="Avenir Next"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
    `</a:fontScheme>` +
    `<a:fmtScheme name="Casserole">` +
    `<a:fillStyleLst>${fill("")}${fill(`<a:tint val="50000"/>`)}${fill(`<a:shade val="75000"/>`)}</a:fillStyleLst>` +
    `<a:lnStyleLst>${ln(6350)}${ln(12700)}${ln(19050)}</a:lnStyleLst>` +
    `<a:effectStyleLst>${effect}${effect}${effect}</a:effectStyleLst>` +
    `<a:bgFillStyleLst>${fill("")}${fill(`<a:tint val="90000"/>`)}${fill(`<a:shade val="85000"/>`)}</a:bgFillStyleLst>` +
    `</a:fmtScheme></a:themeElements></a:theme>`
  );
})();

function rels(entries: { id: string; type: string; target: string }[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    entries.map((e) => `<Relationship Id="${e.id}" Type="${REL_NS}/${e.type}" Target="${e.target}"/>`).join("") +
    `</Relationships>`
  );
}

// ---------- export ----------

export async function exportPptx(deck: DeckModel): Promise<{ bytes: Uint8Array; report: LossReport }> {
  const n = deck.slides.length;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
    deck.slides
      .map(
        (_, i) =>
          `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
      )
      .join("") +
    `</Types>`;

  const presentation =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:presentation ${NS_P} ${NS_A} ${NS_R}>` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst>` +
    deck.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("") +
    `</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_CX}" cy="${SLIDE_CY}"/><p:notesSz cx="${SLIDE_CY}" cy="${SLIDE_CX}"/>` +
    `</p:presentation>`;

  const presRels = rels([
    { id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
    ...deck.slides.map((_, i) => ({
      id: `rId${i + 2}`,
      type: "slide",
      target: `slides/slide${i + 1}.xml`,
    })),
  ]);

  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: textEncoder.encode(contentTypes) },
    {
      name: "_rels/.rels",
      data: textEncoder.encode(rels([{ id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" }])),
    },
    { name: "ppt/presentation.xml", data: textEncoder.encode(presentation) },
    { name: "ppt/_rels/presentation.xml.rels", data: textEncoder.encode(presRels) },
    { name: "ppt/slideMasters/slideMaster1.xml", data: textEncoder.encode(SLIDE_MASTER) },
    {
      name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      data: textEncoder.encode(
        rels([
          { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
          { id: "rId2", type: "theme", target: "../theme/theme1.xml" },
        ])
      ),
    },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: textEncoder.encode(SLIDE_LAYOUT) },
    {
      name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      data: textEncoder.encode(rels([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }])),
    },
    { name: "ppt/theme/theme1.xml", data: textEncoder.encode(THEME) },
  ];
  deck.slides.forEach((slide, i) => {
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: textEncoder.encode(slideXml(slide)) });
    entries.push({
      name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      data: textEncoder.encode(rels([{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }])),
    });
  });

  void n;
  return {
    bytes: await zipWrite(entries),
    report: {
      format: "pptx",
      lossless: true,
      warnings: [],
    },
  };
}
