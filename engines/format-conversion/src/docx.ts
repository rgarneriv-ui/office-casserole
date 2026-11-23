/**
 * DOCX (WordprocessingML) conversion for the Write model subset — spec §5.2.
 * Developed against ECMA-376 packaging/markup conventions for the supported
 * subset. Export covers the full v0 model (paragraphs, heading1/2, bold,
 * italic, underline) and is lossless for it. Import maps the same subset and
 * reports everything it cannot represent in a LossReport instead of claiming
 * fidelity. XML parsing is injectable so the engine stays testable in Node.
 */

import { Block, BlockType, DocModel, Mark, SCHEMA_VERSION } from "../../document-model/src/types";
import { contentHash, newBlock, normalizeModel, validateModel } from "../../document-model/src/model";
import { LossReport, LossWarning } from "../../document-model/src/serialize";
import { ZipEntry, zipRead, zipWrite } from "./zip";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

// ---------- export ----------

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE_ID: Record<BlockType, string | null> = {
  paragraph: null,
  heading1: "Heading1",
  heading2: "Heading2",
  bullet: null,
  numbered: null,
  table: null,
};

/** numId 1 = bullet list, numId 2 = decimal list (see NUMBERING_XML). */
const NUM_ID: Partial<Record<BlockType, number>> = { bullet: 1, numbered: 2 };

function runXml(text: string, marks: Mark[]): string {
  const props: string[] = [];
  if (marks.includes("bold")) props.push("<w:b/>");
  if (marks.includes("italic")) props.push("<w:i/>");
  if (marks.includes("underline")) props.push('<w:u w:val="single"/>');
  const rPr = props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function paragraphXml(block: Block): string {
  const styleId = STYLE_ID[block.type];
  const numId = NUM_ID[block.type];
  const props: string[] = [];
  if (styleId) props.push(`<w:pStyle w:val="${styleId}"/>`);
  if (numId !== undefined) {
    const ilvl = Math.max(0, Math.min(3, block.indent ?? 0));
    props.push(`<w:pStyle w:val="ListParagraph"/>`);
    props.push(`<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);
  }
  const pPr = props.length ? `<w:pPr>${props.join("")}</w:pPr>` : "";
  const runs = block.runs.map((r) => runXml(r.text, r.marks)).join("");
  return `<w:p>${pPr}${runs}</w:p>`;
}

const NUMBERING_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<w:numbering xmlns:w="${'$'}{W_NS}">`
    .replace("${W_NS}", W_NS) +
  `<w:abstractNum w:abstractNumId="1">` +
  ["\u2022", "o", "\u25aa", "\u2023"]
    .map(
      (glyph, lvl) =>
        `<w:lvl w:ilvl="${lvl}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
        `<w:lvlText w:val="${glyph}"/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${720 * (lvl + 1)}" w:hanging="360"/></w:pPr></w:lvl>`
    )
    .join("") +
  `</w:abstractNum>` +
  `<w:abstractNum w:abstractNumId="2">` +
  ["decimal", "lowerLetter", "lowerRoman", "decimal"]
    .map(
      (fmt, lvl) =>
        `<w:lvl w:ilvl="${lvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>` +
        `<w:lvlText w:val="%${lvl + 1}${lvl === 3 ? ")" : "."}"/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${720 * (lvl + 1)}" w:hanging="360"/></w:pPr></w:lvl>`
    )
    .join("") +
  `</w:abstractNum>` +
  `<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>` +
  `<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>` +
  `</w:numbering>`;


function tableXml(table: string[][], style: import("../../document-model/src/types").TableStyle = {}): string {
  const cols = table[0]!.length;
  const totalW = 9360; // dxa across a 6.5in text width
  const weights = style.widths ?? new Array<number>(cols).fill(1);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const colWs = weights.map((w) => Math.max(300, Math.floor((totalW * w) / weightSum)));
  const borders =
    `<w:tblBorders>` +
    ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:color="auto"/>`)
      .join("") +
    `</w:tblBorders>`;
  const grid = `<w:tblGrid>${colWs.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`;
  const rows = table
    .map((row, r) => {
      const isHeader = style.headerRow === true && r === 0;
      const trPr = isHeader ? `<w:trPr><w:tblHeader/></w:trPr>` : "";
      return (
        `<w:tr>${trPr}` +
        row
          .map((cell, c) => {
            const jc = style.aligns?.[c] ? `<w:jc w:val="${style.aligns[c]}"/>` : "";
            const pPr = jc ? `<w:pPr>${jc}</w:pPr>` : "";
            const rPr = isHeader ? `<w:rPr><w:b/></w:rPr>` : "";
            return (
              `<w:tc><w:tcPr><w:tcW w:w="${colWs[c]}" w:type="dxa"/></w:tcPr>` +
              cell
                .split("\n")
                .map(
                  (line) =>
                    `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`
                )
                .join("") +
              `</w:tc>`
            );
          })
          .join("") +
        `</w:tr>`
      );
    })
    .join("");
  return `<w:tbl><w:tblPr>${borders}</w:tblPr>${grid}${rows}</w:tbl>`;
}

function documentXml(model: DocModel, warnings: LossWarning[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document xmlns:w="${W_NS}"><w:body>` +
    model.blocks
      .map((b, bi) => {
        if (b.foreignDocx) {
          if (contentHash(b) === b.foreignDocx.hash) {
            return b.foreignDocx.xml; // untouched: the original construct survives
          }
          warnings.push({
            code: "DOCX-FOREIGN-DROPPED",
            message: `Paragraph ${bi + 1} was edited, so its preserved construct (field/link/control/comment anchor) was replaced by the edited plain content.`,
            blockIndex: bi,
          });
        }
        return b.type === "table" && b.table ? tableXml(b.table, b.tableStyle) : paragraphXml(b);
      })
      .join("") +
    `<w:sectPr/></w:body></w:document>`
  );
}

function stylesXml(): string {
  const heading = (id: string, name: string, size: number) =>
    `<w:style w:type="paragraph" w:styleId="${id}">` +
    `<w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr>` +
    `<w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:styles xmlns:w="${W_NS}">` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    heading("Heading1", "heading 1", 48) +
    heading("Heading2", "heading 2", 36) +
    `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>` +
    `<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>` +
    `</w:styles>`
  );
}

const CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
  `</Types>`;

const ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`;

const DOC_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
  `</Relationships>`;

export interface DocxExportOptions {
  /** Parts from a previous import to carry through (§5.1). */
  preserved?: PreservedPart[];
}

function mergeContentTypes(sourceXml: string): string {
  let xml = sourceXml;
  const ensure = (needle: string, insert: string) => {
    if (!xml.includes(needle)) xml = xml.replace("</Types>", `${insert}</Types>`);
  };
  ensure('Extension="rels"', `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`);
  ensure('Extension="xml"', `<Default Extension="xml" ContentType="application/xml"/>`);
  ensure('PartName="/word/document.xml"', `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`);
  ensure('PartName="/word/numbering.xml"', `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`);
  ensure('PartName="/word/styles.xml"', `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`);
  return xml;
}

function mergeDocRels(sourceXml: string): string {
  let xml = sourceXml;
  const ensure = (target: string, type: string, id: string) => {
    if (!xml.includes(`Target="${target}"`)) {
      xml = xml.replace(
        "</Relationships>",
        `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`
      );
    }
  };
  ensure("styles.xml", "styles", "rIdCasStyles");
  ensure("numbering.xml", "numbering", "rIdCasNumbering");
  return xml;
}

export async function exportDocx(
  model: DocModel,
  options: DocxExportOptions = {}
): Promise<{ bytes: Uint8Array; report: LossReport }> {
  const preserved = options.preserved ?? [];
  const byName = new Map(preserved.map((p) => [p.name, p]));

  // manifests: merge against the source's when present, else ours
  const ctSource = byName.get("[Content_Types].xml");
  const contentTypes = ctSource ? mergeContentTypes(textDecoder.decode(ctSource.data)) : CONTENT_TYPES;
  const relsSource = byName.get("word/_rels/document.xml.rels");
  const docRels = relsSource ? mergeDocRels(textDecoder.decode(relsSource.data)) : DOC_RELS;
  // source styles win (richer theme-linked definitions); ours is the fallback
  const styles = byName.get("word/styles.xml");

  const warnings: LossWarning[] = [];
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: textEncoder.encode(contentTypes) },
    { name: "_rels/.rels", data: textEncoder.encode(ROOT_RELS) },
    { name: "word/document.xml", data: textEncoder.encode(documentXml(model, warnings)) },
    { name: "word/_rels/document.xml.rels", data: textEncoder.encode(docRels) },
    { name: "word/styles.xml", data: styles ? styles.data : textEncoder.encode(stylesXml()) },
    { name: "word/numbering.xml", data: textEncoder.encode(NUMBERING_XML) },
  ];
  const emitted = new Set(entries.map((e) => e.name));
  for (const part of preserved) {
    if (emitted.has(part.name) || OWNED_PARTS.has(part.name) || MERGED_PARTS.has(part.name)) continue;
    entries.push({ name: part.name, data: part.data });
    emitted.add(part.name);
  }
  const bytes = await zipWrite(entries);
  return { bytes, report: { format: "docx", lossless: warnings.length === 0, warnings } };
}

// ---------- import ----------

export type XmlParse = (xml: string) => Document;
export type XmlSerialize = (el: Element) => string;

function defaultSerialize(el: Element): string {
  if (typeof XMLSerializer === "undefined") {
    throw new Error("No XML serializer available: pass serializeXml to importDocx");
  }
  return new XMLSerializer().serializeToString(el);
}

/** An untouched package part carried through import → export (§5.1 Original
 *  Format Preservation). Parts we rebuild (document.xml, numbering.xml, the
 *  relationship/content-type manifests we merge) are never preserved as-is. */
export interface PreservedPart {
  name: string;
  data: Uint8Array;
}

/** Parts the Casserole exporter owns outright — source versions are dropped. */
const OWNED_PARTS = new Set([
  "word/document.xml",
  "word/numbering.xml",
  "_rels/.rels",
]);
/** Parts handled by merge logic rather than byte-preservation. */
const MERGED_PARTS = new Set(["[Content_Types].xml", "word/_rels/document.xml.rels"]);

function defaultParse(xml: string): Document {
  if (typeof DOMParser === "undefined") {
    throw new Error("No XML parser available: pass parseXml to importDocx");
  }
  return new DOMParser().parseFromString(xml, "application/xml");
}

function childrenByLocalName(el: Element, name: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i]!;
    if (c.localName === name) out.push(c);
  }
  return out;
}

function firstByLocalName(el: Element, name: string): Element | null {
  return childrenByLocalName(el, name)[0] ?? null;
}

function descendantsOf(dom: Document, name: string): Element[] {
  const root = dom.documentElement;
  return root ? descendantsByLocalName(root, name) : [];
}

function descendantsByLocalName(el: Element, name: string): Element[] {
  const out: Element[] = [];
  const walk = (e: Element) => {
    for (let i = 0; i < e.children.length; i++) {
      const c = e.children[i]!;
      if (c.localName === name) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

function wAttr(el: Element, name: string): string | null {
  return el.getAttributeNS(W_NS, name) ?? el.getAttribute(`w:${name}`) ?? el.getAttribute(name);
}

const SUPPORTED_P_CHILDREN = new Set(["pPr", "r", "proofErr", "bookmarkStart", "bookmarkEnd"]);
const SUPPORTED_R_CHILDREN = new Set(["rPr", "t", "br", "lastRenderedPageBreak"]);

export async function importDocx(
  bytes: Uint8Array,
  parseXml: XmlParse = defaultParse,
  serializeXml: XmlSerialize = defaultSerialize
): Promise<{ model: DocModel; report: LossReport; preserved: PreservedPart[] }> {
  const warnings: LossWarning[] = [];
  const entries = await zipRead(bytes);
  const docEntry = entries.find((e) => e.name === "word/document.xml");
  if (!docEntry) throw new Error("Not a DOCX package: word/document.xml missing");
  const preserved: PreservedPart[] = entries
    .filter((e) => !OWNED_PARTS.has(e.name))
    .map((e) => ({ name: e.name, data: e.data }));

  const dom = parseXml(textDecoder.decode(docEntry.data));
  const body = dom.getElementsByTagNameNS?.(W_NS, "body")[0] ?? dom.getElementsByTagName("w:body")[0];
  if (!body) throw new Error("Invalid DOCX: no document body");

  // numbering lookup: numId -> numFmt of level 0 (bullet | decimal | ...)
  const numFmtById = new Map<string, string>();
  const numberingEntry = entries.find((e) => e.name === "word/numbering.xml");
  if (numberingEntry) {
    try {
      const numDom = parseXml(textDecoder.decode(numberingEntry.data));
      const abstractFmt = new Map<string, string>();
      for (const abs of descendantsOf(numDom, "abstractNum")) {
        const id = wAttr(abs, "abstractNumId");
        const lvl0 = descendantsByLocalName(abs, "lvl").find((l) => wAttr(l, "ilvl") === "0");
        const fmt = lvl0 ? descendantsByLocalName(lvl0, "numFmt")[0] : undefined;
        if (id && fmt) abstractFmt.set(id, wAttr(fmt, "val") ?? "");
      }
      for (const num of descendantsOf(numDom, "num")) {
        const numId = wAttr(num, "numId");
        const absRef = descendantsByLocalName(num, "abstractNumId")[0];
        const absId = absRef ? wAttr(absRef, "val") : null;
        if (numId && absId && abstractFmt.has(absId)) numFmtById.set(numId, abstractFmt.get(absId)!);
      }
    } catch {
      /* unreadable numbering part: fall through to the warning path */
    }
  }

  const model: DocModel = { schemaVersion: SCHEMA_VERSION, blocks: [] };

  for (let i = 0; i < body.children.length; i++) {
    const el = body.children[i]!;
    const bi = model.blocks.length;
    if (el.localName === "sectPr") continue;
    if (el.localName === "tbl") {
      const data: string[][] = [];
      let spanSeen = false;
      let marksSeen = false;
      let headerRow = false;
      const colWidths: number[] = [];
      for (const gc of descendantsByLocalName(el, "gridCol")) {
        const w = Number(wAttr(gc, "w"));
        if (Number.isFinite(w) && w > 0) colWidths.push(w);
      }
      const aligns: (string | null)[] = [];
      let rowIndex = 0;
      for (const tr of descendantsByLocalName(el, "tr")) {
        if (rowIndex === 0 && descendantsByLocalName(tr, "tblHeader").length > 0) headerRow = true;
        const row: string[] = [];
        let colIndex = 0;
        for (const tc of childrenByLocalName(tr, "tc")) {
          const texts = descendantsByLocalName(tc, "p").map((p) =>
            descendantsByLocalName(p, "t").map((t) => t.textContent ?? "").join("")
          );
          row.push(texts.join("\n"));
          if (rowIndex === (headerRow ? 1 : 0)) {
            // sample alignment from the first body row
            const jcEl = descendantsByLocalName(tc, "jc")[0];
            const jc = jcEl ? wAttr(jcEl, "val") : null;
            aligns[colIndex] = jc === "left" || jc === "center" || jc === "right" ? jc : null;
          }
          if (descendantsByLocalName(tc, "gridSpan").length > 0 || descendantsByLocalName(tc, "vMerge").length > 0) spanSeen = true;
          for (const rPr of descendantsByLocalName(tc, "rPr")) {
            const isHeaderCell = headerRow && rowIndex === 0;
            if ((childrenByLocalName(rPr, "b").length > 0 && !isHeaderCell) || childrenByLocalName(rPr, "i").length || childrenByLocalName(rPr, "u").length) marksSeen = true;
          }
          colIndex++;
        }
        if (row.length > 0) data.push(row);
        rowIndex++;
      }
      if (data.length === 0) continue;
      const cols = Math.max(...data.map((r) => r.length));
      for (const row of data) while (row.length < cols) row.push("");
      const tableBlock = newBlock("table");
      tableBlock.table = data;
      const styleOut: import("../../document-model/src/types").TableStyle = {};
      if (headerRow) styleOut.headerRow = true;
      if (colWidths.length === cols) {
        const min = Math.min(...colWidths);
        const rel = colWidths.map((w) => Math.round((w / min) * 100) / 100);
        if (rel.some((w) => Math.abs(w - 1) > 0.05)) styleOut.widths = rel;
      }
      if (aligns.slice(0, cols).some((a) => a)) {
        styleOut.aligns = Array.from({ length: cols }, (_, c) => (aligns[c] ?? null) as import("../../document-model/src/types").ColAlign);
      }
      if (Object.keys(styleOut).length > 0) tableBlock.tableStyle = styleOut;
      model.blocks.push(tableBlock);
      if (spanSeen)
        warnings.push({ code: "DOCX-IMPORT-TABLE-SPAN", message: "Merged table cells flattened (spans not yet supported).", blockIndex: bi });
      if (marksSeen)
        warnings.push({ code: "DOCX-IMPORT-TABLE-FORMATTING", message: "Character formatting inside table cells was dropped (cells are plain text).", blockIndex: bi });
      continue;
    }
    if (el.localName === "sdt") {
      const innerPs = descendantsByLocalName(el, "p");
      if (innerPs.length === 1) {
        // single-paragraph content control: preserve the whole sdt
        const block = importParagraph(innerPs[0]!, bi, warnings, numFmtById);
        block.foreignDocx = { xml: serializeXml(el), hash: "" };
        block.foreignDocx.hash = hashOf(block);
        warnings.push({
          code: "DOCX-PRESERVED",
          message: `A content control renders as plain text here; it re-exports unchanged unless this paragraph is edited.`,
          blockIndex: bi,
        });
        model.blocks.push(block);
      } else {
        warnings.push({
          code: "DOCX-IMPORT-SDT-UNWRAPPED",
          message: `A multi-paragraph content control was unwrapped (its wrapper is dropped; the content is kept).`,
          blockIndex: bi,
        });
        for (const p2 of innerPs) {
          model.blocks.push(importParagraph(p2, model.blocks.length, warnings, numFmtById, serializeXml));
        }
      }
      continue;
    }
    if (el.localName !== "p") {
      warnings.push({
        code: "DOCX-IMPORT-UNSUPPORTED",
        message: `Unsupported body element <${el.localName}> was skipped.`,
        blockIndex: bi,
      });
      continue;
    }
    model.blocks.push(importParagraph(el, bi, warnings, numFmtById, serializeXml));
  }

  normalizeModel(model);
  // hashes must reflect the post-normalization content (runs may coalesce)
  for (const b of model.blocks) {
    if (b.foreignDocx) b.foreignDocx.hash = contentHash(b);
  }
  const errors = validateModel(model);
  if (errors.length > 0) throw new Error(`DOCX import produced invalid model: ${errors.join("; ")}`);
  return {
    model,
    report: { format: "docx", lossless: warnings.length === 0, warnings },
    preserved,
  };
}

function hashOf(block: Block): string {
  // re-exported from the model to keep one definition
  return contentHash(block);
}

function importParagraph(
  p: Element,
  blockIndex: number,
  warnings: LossWarning[],
  numFmtById: Map<string, string> = new Map(),
  serializeXml?: XmlSerialize
): Block {
  let type: BlockType = "paragraph";
  let pendingIndent = 0;
  const pPr = firstByLocalName(p, "pPr");
  if (pPr) {
    const numPr = firstByLocalName(pPr, "numPr");
    const style = firstByLocalName(pPr, "pStyle");
    const styleId = style ? wAttr(style, "val") : null;
    if (numPr) {
      const numIdEl = firstByLocalName(numPr, "numId");
      const numId = numIdEl ? wAttr(numIdEl, "val") : null;
      const fmt = numId ? numFmtById.get(numId) : undefined;
      if (fmt === "bullet") type = "bullet";
      else if (fmt !== undefined) type = "numbered";
      else {
        type = "numbered";
        warnings.push({
          code: "DOCX-IMPORT-NUMBERING",
          message: "Numbered paragraph whose numbering definition could not be resolved; imported as a numbered item.",
          blockIndex,
        });
      }
      const ilvlEl = firstByLocalName(numPr, "ilvl");
      const ilvl = Number((ilvlEl ? wAttr(ilvlEl, "val") : "0") ?? 0);
      if (ilvl > 3) {
        warnings.push({
          code: "DOCX-IMPORT-LIST-LEVEL",
          message: `List level ${ilvl} clamped to level 3 (deeper nesting not supported).`,
          blockIndex,
        });
      }
      pendingIndent = Math.max(0, Math.min(3, ilvl));
    } else if (styleId === "Heading1" || styleId === "Title") type = "heading1";
    else if (styleId === "Heading2") type = "heading2";
    else if (styleId && /^Heading[3-9]$/.test(styleId)) {
      type = "heading2";
      warnings.push({
        code: "DOCX-IMPORT-HEADING-LEVEL",
        message: `${styleId} mapped to Heading 2 (deeper heading levels not yet supported).`,
        blockIndex,
      });
    } else if (styleId && styleId !== "Normal" && styleId !== "ListParagraph") {
      warnings.push({
        code: "DOCX-IMPORT-STYLE",
        message: `Paragraph style "${styleId}" mapped to plain paragraph.`,
        blockIndex,
      });
    }
  }

  const block = newBlock(type);
  if ((type === "bullet" || type === "numbered") && pendingIndent > 0) block.indent = pendingIndent;
  const foreignKinds = new Set<string>();
  for (const child of Array.from(p.children)) {
    if (child.localName === "r") {
      const marks: Mark[] = [];
      const rPr = firstByLocalName(child, "rPr");
      if (rPr) {
        for (const prop of Array.from(rPr.children)) {
          const val = wAttr(prop, "val");
          const off = val === "0" || val === "false" || val === "none";
          if (prop.localName === "b" && !off) marks.push("bold");
          else if (prop.localName === "i" && !off) marks.push("italic");
          else if (prop.localName === "u" && !off) marks.push("underline");
          else if (!["b", "i", "u", "rFonts", "sz", "szCs", "lang", "noProof"].includes(prop.localName)) {
            warnings.push({
              code: "DOCX-IMPORT-RUN-PROP",
              message: `Run property <${prop.localName}> not supported; formatting dropped.`,
              blockIndex,
            });
          }
        }
      }
      for (const rc of Array.from(child.children)) {
        if (rc.localName === "t") {
          block.runs.push({ text: rc.textContent ?? "", marks: [...marks] });
        } else if (rc.localName === "instrText" || rc.localName === "fldChar") {
          foreignKinds.add("field");
        } else if (rc.localName === "commentReference") {
          foreignKinds.add("comment anchor");
        } else if (!SUPPORTED_R_CHILDREN.has(rc.localName)) {
          foreignKinds.add(`<${rc.localName}>`);
        }
      }
    } else if (child.localName === "hyperlink") {
      for (const t of descendantsByLocalName(child, "t")) {
        block.runs.push({ text: t.textContent ?? "", marks: ["underline"] });
      }
      foreignKinds.add("hyperlink");
    } else if (child.localName === "fldSimple") {
      for (const t of descendantsByLocalName(child, "t")) {
        block.runs.push({ text: t.textContent ?? "", marks: [] });
      }
      foreignKinds.add("field");
    } else if (child.localName === "sdt") {
      for (const t of descendantsByLocalName(child, "t")) {
        block.runs.push({ text: t.textContent ?? "", marks: [] });
      }
      foreignKinds.add("content control");
    } else if (
      child.localName === "commentRangeStart" ||
      child.localName === "commentRangeEnd"
    ) {
      foreignKinds.add("comment anchor");
    } else if (!SUPPORTED_P_CHILDREN.has(child.localName)) {
      foreignKinds.add(`<${child.localName}>`);
    }
  }
  if (foreignKinds.size > 0) {
    if (serializeXml) {
      block.foreignDocx = { xml: serializeXml(p), hash: "" };
      block.foreignDocx.hash = hashOf(block);
      warnings.push({
        code: "DOCX-PRESERVED",
        message: `Preserved in place: ${[...foreignKinds].join(", ")} (renders as plain text here; re-exports unchanged unless this paragraph is edited).`,
        blockIndex,
      });
    } else {
      warnings.push({
        code: "DOCX-IMPORT-PARA-CONTENT",
        message: `Unsupported paragraph content dropped: ${[...foreignKinds].join(", ")}.`,
        blockIndex,
      });
    }
  }
  return block;
}
