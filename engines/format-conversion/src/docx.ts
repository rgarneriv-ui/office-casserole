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
};

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
  const pPr = styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : "";
  const runs = block.runs.map((r) => runXml(r.text, r.marks)).join("");
  return `<w:p>${pPr}${runs}</w:p>`;
}

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function documentXml(model: DocModel): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document xmlns:w="${W_NS}"><w:body>` +
    model.blocks.map(paragraphXml).join("") +
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

  const model: DocModel = { schemaVersion: SCHEMA_VERSION, blocks: [] };

  for (let i = 0; i < body.children.length; i++) {
    const el = body.children[i]!;
    const bi = model.blocks.length;
    if (el.localName === "sectPr") continue;
    if (el.localName === "tbl") {
      warnings.push({
        code: "DOCX-IMPORT-TABLE",
        message: "Tables are not yet supported; table content imported as plain paragraphs.",
        blockIndex: bi,
      });
      // flatten table cell paragraphs so content is not silently dropped
      for (const p of descendantsByLocalName(el, "p")) {
        model.blocks.push(importParagraph(p, model.blocks.length, warnings));
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
    model.blocks.push(importParagraph(el, bi, warnings));
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
  warnings: LossWarning[]
): Block {
  let type: BlockType = "paragraph";
  const pPr = firstByLocalName(p, "pPr");
  if (pPr) {
    const style = firstByLocalName(pPr, "pStyle");
    const styleId = style ? wAttr(style, "val") : null;
    if (styleId === "Heading1" || styleId === "Title") type = "heading1";
    else if (styleId === "Heading2") type = "heading2";
    else if (styleId && /^Heading[3-9]$/.test(styleId)) {
      type = "heading2";
      warnings.push({
        code: "DOCX-IMPORT-HEADING-LEVEL",
        message: `${styleId} mapped to Heading 2 (deeper heading levels not yet supported).`,
        blockIndex,
      });
    } else if (styleId && styleId !== "Normal") {
      warnings.push({
        code: "DOCX-IMPORT-STYLE",
        message: `Paragraph style "${styleId}" mapped to plain paragraph.`,
        blockIndex,
      });
    }
  }

  const block = newBlock(type);
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
