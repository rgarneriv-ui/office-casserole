/**
 * DOCX (WordprocessingML) conversion for the Write model subset — spec §5.2.
 * Developed against ECMA-376 packaging/markup conventions for the supported
 * subset. Export covers the full v0 model (paragraphs, heading1/2, bold,
 * italic, underline) and is lossless for it. Import maps the same subset and
 * reports everything it cannot represent in a LossReport instead of claiming
 * fidelity. XML parsing is injectable so the engine stays testable in Node.
 */

import { Block, BlockType, DocModel, Mark, SCHEMA_VERSION } from "../../document-model/src/types";
import { newBlock, normalizeModel, validateModel } from "../../document-model/src/model";
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


function tableXml(table: string[][]): string {
  const colW = Math.floor(9360 / table[0]!.length); // dxa across a 6.5in text width
  const borders =
    `<w:tblBorders>` +
    ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:color="auto"/>`)
      .join("") +
    `</w:tblBorders>`;
  const grid = `<w:tblGrid>${table[0]!.map(() => `<w:gridCol w:w="${colW}"/>`).join("")}</w:tblGrid>`;
  const rows = table
    .map(
      (row) =>
        `<w:tr>` +
        row
          .map(
            (cell) =>
              `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/></w:tcPr>` +
              cell
                .split("\n")
                .map((line) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`)
                .join("") +
              `</w:tc>`
          )
          .join("") +
        `</w:tr>`
    )
    .join("");
  return `<w:tbl><w:tblPr>${borders}</w:tblPr>${grid}${rows}</w:tbl>`;
}

function documentXml(model: DocModel): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document xmlns:w="${W_NS}"><w:body>` +
    model.blocks
      .map((b) => (b.type === "table" && b.table ? tableXml(b.table) : paragraphXml(b)))
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

export async function exportDocx(
  model: DocModel
): Promise<{ bytes: Uint8Array; report: LossReport }> {
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: textEncoder.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: textEncoder.encode(ROOT_RELS) },
    { name: "word/document.xml", data: textEncoder.encode(documentXml(model)) },
    { name: "word/_rels/document.xml.rels", data: textEncoder.encode(DOC_RELS) },
    { name: "word/styles.xml", data: textEncoder.encode(stylesXml()) },
    { name: "word/numbering.xml", data: textEncoder.encode(NUMBERING_XML) },
  ];
  const bytes = await zipWrite(entries);
  // The v0 model subset is fully representable in WordprocessingML.
  return { bytes, report: { format: "docx", lossless: true, warnings: [] } };
}

// ---------- import ----------

export type XmlParse = (xml: string) => Document;

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
  parseXml: XmlParse = defaultParse
): Promise<{ model: DocModel; report: LossReport }> {
  const warnings: LossWarning[] = [];
  const entries = await zipRead(bytes);
  const docEntry = entries.find((e) => e.name === "word/document.xml");
  if (!docEntry) throw new Error("Not a DOCX package: word/document.xml missing");

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
      for (const tr of descendantsByLocalName(el, "tr")) {
        const row: string[] = [];
        for (const tc of childrenByLocalName(tr, "tc")) {
          const texts = descendantsByLocalName(tc, "p").map((p) =>
            descendantsByLocalName(p, "t").map((t) => t.textContent ?? "").join("")
          );
          row.push(texts.join("\n"));
          if (descendantsByLocalName(tc, "gridSpan").length > 0 || descendantsByLocalName(tc, "vMerge").length > 0) spanSeen = true;
          for (const rPr of descendantsByLocalName(tc, "rPr")) {
            if (childrenByLocalName(rPr, "b").length || childrenByLocalName(rPr, "i").length || childrenByLocalName(rPr, "u").length) marksSeen = true;
          }
        }
        if (row.length > 0) data.push(row);
      }
      if (data.length === 0) continue;
      const cols = Math.max(...data.map((r) => r.length));
      for (const row of data) while (row.length < cols) row.push("");
      const tableBlock = newBlock("table");
      tableBlock.table = data;
      model.blocks.push(tableBlock);
      if (spanSeen)
        warnings.push({ code: "DOCX-IMPORT-TABLE-SPAN", message: "Merged table cells flattened (spans not yet supported).", blockIndex: bi });
      if (marksSeen)
        warnings.push({ code: "DOCX-IMPORT-TABLE-FORMATTING", message: "Character formatting inside table cells was dropped (cells are plain text).", blockIndex: bi });
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
    model.blocks.push(importParagraph(el, bi, warnings, numFmtById));
  }

  normalizeModel(model);
  const errors = validateModel(model);
  if (errors.length > 0) throw new Error(`DOCX import produced invalid model: ${errors.join("; ")}`);
  return {
    model,
    report: { format: "docx", lossless: warnings.length === 0, warnings },
  };
}

function importParagraph(
  p: Element,
  blockIndex: number,
  warnings: LossWarning[],
  numFmtById: Map<string, string> = new Map()
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
        } else if (!SUPPORTED_R_CHILDREN.has(rc.localName)) {
          warnings.push({
            code: "DOCX-IMPORT-RUN-CONTENT",
            message: `Run content <${rc.localName}> was skipped.`,
            blockIndex,
          });
        }
      }
    } else if (child.localName === "hyperlink") {
      // keep the text, report the lost link target
      for (const t of descendantsByLocalName(child, "t")) {
        block.runs.push({ text: t.textContent ?? "", marks: ["underline"] });
      }
      warnings.push({
        code: "DOCX-IMPORT-HYPERLINK",
        message: "Hyperlink target dropped; link text kept (links not yet in the model).",
        blockIndex,
      });
    } else if (!SUPPORTED_P_CHILDREN.has(child.localName)) {
      warnings.push({
        code: "DOCX-IMPORT-PARA-CONTENT",
        message: `Paragraph content <${child.localName}> was skipped.`,
        blockIndex,
      });
    }
  }
  return block;
}
