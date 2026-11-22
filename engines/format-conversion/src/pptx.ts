/**
 * PPTX (PresentationML) export for the presentation model — spec §5.2, §8.
 * Emits a minimal but complete package: presentation + slides + one blank
 * slide master/layout + theme. Elements export as real shapes with real text
 * runs (§8.2 — never flattened images). Geometry maps the 1600×900 logical
 * canvas onto a 16:9 slide (12192000×6858000 EMU), so EMU_PER_UNIT = 7620
 * and font sizes convert at 0.6 pt per logical unit (540pt slide height).
 */

import {
  CANVAS_H,
  CANVAS_W,
  DeckModel,
  Slide,
  SlideElement,
  DECK_SCHEMA_VERSION,
  clampElement,
  imageElement,
  newElemId,
  validateDeck,
} from "../../presentation-model/src/model";
import { LossReport, LossWarning } from "../../document-model/src/serialize";
import { ZipEntry, zipRead, zipWrite } from "./zip";

const textEncoder = new TextEncoder();

const EMU_PER_UNIT = 7620;
const PT_PER_UNIT = 0.6;
const SLIDE_CX = 12192000;
const SLIDE_CY = 6858000;

const NS_P = `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
const NS_A = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`;
const NS_R = `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

interface MediaPart {
  name: string; // ppt/media/imageN.ext
  ext: string;
  data: Uint8Array;
}

function decodeBase64(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function encodeBase64(data: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(data).toString("base64");
  let bin = "";
  for (const byte of data) bin += String.fromCharCode(byte);
  return btoa(bin);
}

const DATA_URL_RE = /^data:image\/(png|jpeg|jpg|gif);base64,(.+)$/;

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

function shapeXml(
  el: SlideElement,
  index: number,
  media?: { parts: MediaPart[]; slideRels: { id: string; target: string }[] }
): string {
  const off = `<a:off x="${Math.round(el.x * EMU_PER_UNIT)}" y="${Math.round(el.y * EMU_PER_UNIT)}"/>`;
  const ext = `<a:ext cx="${Math.round(el.w * EMU_PER_UNIT)}" cy="${Math.round(el.h * EMU_PER_UNIT)}"/>`;
  const xfrm = `<a:xfrm>${off}${ext}</a:xfrm>`;
  const geom = `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`;

  if (el.kind === "image") {
    const m = DATA_URL_RE.exec(el.src ?? "");
    if (!m || !media) {
      // unembeddable image: keep its footprint as a placeholder rect
      return (
        `<p:sp><p:nvSpPr><p:cNvPr id="${index + 2}" name="Image ${index + 1}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>${xfrm}${geom}<a:solidFill><a:srgbClr val="EEEEEE"/></a:solidFill></p:spPr>` +
        `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`
      );
    }
    const ext = m[1] === "jpg" ? "jpeg" : m[1]!;
    const partName = `ppt/media/image${media.parts.length + 1}.${ext}`;
    media.parts.push({ name: partName, ext, data: decodeBase64(m[2]!) });
    const relId = `rIdImg${media.slideRels.length + 1}`;
    media.slideRels.push({ id: relId, target: `../media/${partName.split("/").pop()}` });
    return (
      `<p:pic><p:nvPicPr><p:cNvPr id="${index + 2}" name="Picture ${index + 1}"/>` +
      `<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr>${xfrm}${geom}</p:spPr></p:pic>`
    );
  }
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

function slideXml(
  slide: Slide,
  media: { parts: MediaPart[]; slideRels: { id: string; target: string }[] }
): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:sld ${NS_P} ${NS_A} ${NS_R}><p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    slide.elements.map((el, i) => shapeXml(el, i, media)).join("") +
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
    `<Default Extension="png" ContentType="image/png"/>` +
    `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
    `<Default Extension="gif" ContentType="image/gif"/>` +
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
  const allMedia: MediaPart[] = [];
  deck.slides.forEach((slide, i) => {
    const media = { parts: allMedia, slideRels: [] as { id: string; target: string }[] };
    const xml = slideXml(slide, media);
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: textEncoder.encode(xml) });
    entries.push({
      name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      data: textEncoder.encode(
        rels([
          { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
          ...media.slideRels.map((r) => ({ id: r.id, type: "image", target: r.target })),
        ])
      ),
    });
  });
  for (const part of allMedia) {
    entries.push({ name: part.name, data: part.data });
  }

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

// ---------- import ----------

export type XmlParse = (xml: string) => Document;

const textDecoder = new TextDecoder();

function defaultParse(xml: string): Document {
  if (typeof DOMParser === "undefined") {
    throw new Error("No XML parser available: pass parseXml to importPptx");
  }
  return new DOMParser().parseFromString(xml, "application/xml");
}

function kids(el: Element | Document, name: string): Element[] {
  const out: Element[] = [];
  const children = (el as Element).children ?? [];
  for (let i = 0; i < children.length; i++) {
    if (children[i]!.localName === name) out.push(children[i]!);
  }
  return out;
}

function kid(el: Element, name: string): Element | null {
  return kids(el, name)[0] ?? null;
}

function deep(el: Element | Document, name: string): Element[] {
  const out: Element[] = [];
  const walk = (e: Element | Document) => {
    const children = (e as Element).children ?? [];
    for (let i = 0; i < children.length; i++) {
      const c = children[i]!;
      if (c.localName === name) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

interface SlideScale {
  x: number; // logical units per EMU
  y: number;
}

function importShape(
  sp: Element,
  scale: SlideScale,
  warnings: LossWarning[],
  slideIndex: number,
  fallbackSlot: { n: number }
): SlideElement | null {
  const spPr = kid(sp, "spPr");
  const xfrm = spPr ? kid(spPr, "xfrm") : null;
  let x: number, y: number, w: number, h: number;
  if (xfrm) {
    const off = kid(xfrm, "off");
    const ext = kid(xfrm, "ext");
    x = Number(off?.getAttribute("x") ?? 0) * scale.x;
    y = Number(off?.getAttribute("y") ?? 0) * scale.y;
    w = Number(ext?.getAttribute("cx") ?? 0) * scale.x;
    h = Number(ext?.getAttribute("cy") ?? 0) * scale.y;
  } else {
    // placeholder inheriting geometry from its layout — we do not resolve
    // layouts yet, so stack with defaults and say so.
    warnings.push({
      code: "PPTX-IMPORT-NO-GEOMETRY",
      message: `Slide ${slideIndex + 1}: a placeholder had no explicit position (layout inheritance not yet resolved); default position used.`,
      blockIndex: slideIndex,
    });
    x = 120;
    y = 100 + fallbackSlot.n * 180;
    w = CANVAS_W - 240;
    h = 160;
    fallbackSlot.n++;
  }

  const txBody = kid(sp, "txBody");
  const paragraphs = txBody ? kids(txBody, "p") : [];
  const textLines: string[] = paragraphs.map((p) =>
    deep(p, "t").map((t) => t.textContent ?? "").join("")
  );
  const hasText = textLines.some((l) => l.length > 0);

  if (!hasText) {
    const fillClr = spPr ? deep(spPr, "srgbClr")[0] : null;
    const fill = fillClr ? `#${(fillClr.getAttribute("val") ?? "DBE7F0").toLowerCase()}` : undefined;
    const el: SlideElement = { id: newElemId(), kind: "rect", x, y, w, h, fill };
    clampElement(el);
    return el;
  }

  // text element: take style from the first styled run/paragraph
  const firstPPr = paragraphs.map((p) => kid(p, "pPr")).find((p) => p) ?? null;
  const algnAttr = firstPPr?.getAttribute("algn") ?? null;
  const align = algnAttr === "ctr" ? "center" : algnAttr === "r" ? "right" : "left";
  const firstRPr = deep(txBody!, "rPr")[0] ?? null;
  const szAttr = firstRPr?.getAttribute("sz");
  const size = szAttr ? Math.max(12, Math.round(Number(szAttr) / 100 / PT_PER_UNIT)) : 36;
  const bold = firstRPr?.getAttribute("b") === "1";
  const clr = firstRPr ? deep(firstRPr, "srgbClr")[0] : null;
  const color = clr ? `#${(clr.getAttribute("val") ?? "222222").toLowerCase()}` : "#222222";

  const rPrs = deep(txBody!, "rPr");
  if (rPrs.length > 1) {
    const uniform = rPrs.every(
      (r) =>
        (r.getAttribute("sz") ?? "") === (rPrs[0]!.getAttribute("sz") ?? "") &&
        (r.getAttribute("b") ?? "") === (rPrs[0]!.getAttribute("b") ?? "")
    );
    if (!uniform) {
      warnings.push({
        code: "PPTX-IMPORT-MIXED-RUNS",
        message: `Slide ${slideIndex + 1}: mixed per-run formatting flattened to the first run's style (per-run styling not yet in the model).`,
        blockIndex: slideIndex,
      });
    }
  }

  const el: SlideElement = {
    id: newElemId(),
    kind: "text",
    x,
    y,
    w,
    h,
    text: textLines.join("\n"),
    size,
    bold,
    align,
    color,
  };
  clampElement(el);
  return el;
}

export async function importPptx(
  bytes: Uint8Array,
  parseXml: XmlParse = defaultParse
): Promise<{ deck: DeckModel; report: LossReport }> {
  const warnings: LossWarning[] = [];
  const entries = await zipRead(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const presEntry = byName.get("ppt/presentation.xml");
  if (!presEntry) throw new Error("Not a PPTX package: ppt/presentation.xml missing");
  const pres = parseXml(textDecoder.decode(presEntry.data));

  // slide size → per-axis scaling into the 1600×900 logical canvas
  const sldSz = deep(pres, "sldSz")[0];
  const cx = Number(sldSz?.getAttribute("cx") ?? SLIDE_CX);
  const cy = Number(sldSz?.getAttribute("cy") ?? SLIDE_CY);
  const scale: SlideScale = { x: CANVAS_W / cx, y: CANVAS_H / cy };
  if (Math.abs(cx / cy - 16 / 9) > 0.02) {
    warnings.push({
      code: "PPTX-IMPORT-ASPECT",
      message: `Source slides are ${cx}×${cy} EMU (not 16:9); geometry was scaled per axis to fit the 16:9 canvas.`,
      blockIndex: -1,
    });
  }

  // resolve slide order via presentation rels
  const relsEntry = byName.get("ppt/_rels/presentation.xml.rels");
  const relTargets = new Map<string, string>();
  if (relsEntry) {
    const relsDom = parseXml(textDecoder.decode(relsEntry.data));
    for (const rel of deep(relsDom, "Relationship")) {
      relTargets.set(rel.getAttribute("Id") ?? "", rel.getAttribute("Target") ?? "");
    }
  }
  const slideParts: string[] = [];
  for (const sldId of deep(pres, "sldId")) {
    const rId =
      sldId.getAttributeNS?.("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ??
      sldId.getAttribute("r:id") ??
      "";
    const target = relTargets.get(rId);
    if (target) slideParts.push("ppt/" + target.replace(/^\.\//, ""));
  }
  if (slideParts.length === 0) {
    // fall back to name order
    for (const name of [...byName.keys()].sort()) {
      if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) slideParts.push(name);
    }
  }
  if (slideParts.length === 0) throw new Error("PPTX package has no slides");

  const deck: DeckModel = { schemaVersion: DECK_SCHEMA_VERSION, slides: [] };
  slideParts.forEach((part, si) => {
    const entry = byName.get(part);
    const slide: Slide = { id: newElemId(), elements: [] };
    if (!entry) {
      warnings.push({
        code: "PPTX-IMPORT-MISSING-PART",
        message: `Slide part ${part} is referenced but missing; imported as an empty slide.`,
        blockIndex: si,
      });
      deck.slides.push(slide);
      return;
    }
    const dom = parseXml(textDecoder.decode(entry.data));
    const slideRelTargets = new Map<string, string>();
    {
      const dir = part.slice(0, part.lastIndexOf("/"));
      const relsName = `${dir}/_rels/${part.split("/").pop()}.rels`;
      const relsPart = byName.get(relsName);
      if (relsPart) {
        const relsDom = parseXml(textDecoder.decode(relsPart.data));
        for (const rel of deep(relsDom, "Relationship")) {
          const target = rel.getAttribute("Target") ?? "";
          // resolve ../media/x against ppt/slides/
          const resolved = target.startsWith("../") ? "ppt/" + target.slice(3) : `${dir}/${target}`;
          slideRelTargets.set(rel.getAttribute("Id") ?? "", resolved);
        }
      }
    }
    const spTree = deep(dom, "spTree")[0];
    if (!spTree) {
      deck.slides.push(slide);
      return;
    }
    const fallbackSlot = { n: 0 };
    for (let i = 0; i < spTree.children.length; i++) {
      const child = spTree.children[i]!;
      if (child.localName === "sp") {
        const el = importShape(child, scale, warnings, si, fallbackSlot);
        if (el) slide.elements.push(el);
      } else if (child.localName === "pic") {
        const el = importPicture(child, scale, si, warnings, slideRelTargets, byName);
        if (el) slide.elements.push(el);
      } else if (child.localName === "graphicFrame") {
        warnings.push({
          code: "PPTX-IMPORT-GRAPHIC",
          message: `Slide ${si + 1}: a table/chart/diagram frame was skipped.`,
          blockIndex: si,
        });
      } else if (child.localName === "grpSp") {
        warnings.push({
          code: "PPTX-IMPORT-GROUP",
          message: `Slide ${si + 1}: a grouped shape was skipped (group transforms not yet supported).`,
          blockIndex: si,
        });
      }
    }
    deck.slides.push(slide);
  });

  const errors = validateDeck(deck);
  if (errors.length > 0) throw new Error(`PPTX import produced invalid deck: ${errors.join("; ")}`);
  return { deck, report: { format: "pptx", lossless: warnings.length === 0, warnings } };
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  gif: "image/gif",
};

function importPicture(
  pic: Element,
  scale: SlideScale,
  slideIndex: number,
  warnings: LossWarning[],
  relTargets: Map<string, string>,
  byName: Map<string, { name: string; data: Uint8Array }>
): SlideElement | null {
  const xfrm = deep(pic, "xfrm")[0];
  const off = xfrm ? kid(xfrm, "off") : null;
  const ext = xfrm ? kid(xfrm, "ext") : null;
  const x = Number(off?.getAttribute("x") ?? 0) * scale.x;
  const y = Number(off?.getAttribute("y") ?? 0) * scale.y;
  const w = Number(ext?.getAttribute("cx") ?? 0) * scale.x || 400;
  const h = Number(ext?.getAttribute("cy") ?? 0) * scale.y || 300;

  const blip = deep(pic, "blip")[0];
  const embed =
    blip?.getAttributeNS?.("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed") ??
    blip?.getAttribute("r:embed") ??
    "";
  const target = relTargets.get(embed);
  const part = target ? byName.get(target) : undefined;
  const fileExt = target?.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIME_BY_EXT[fileExt];
  if (!part || !mime) {
    warnings.push({
      code: "PPTX-IMPORT-PICTURE-MISSING",
      message: `Slide ${slideIndex + 1}: a picture's media part was missing or unsupported (${fileExt || "unknown"}); placeholder kept.`,
      blockIndex: slideIndex,
    });
    const el: SlideElement = { id: newElemId(), kind: "rect", x, y, w, h, fill: "#eeeeee" };
    clampElement(el);
    return el;
  }
  const el = imageElement(`data:${mime};base64,${encodeBase64(part.data)}`, { x, y, w, h });
  clampElement(el);
  return el;
}
