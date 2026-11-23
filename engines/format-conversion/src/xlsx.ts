/**
 * XLSX (SpreadsheetML) conversion for the Sheets engine — spec §5.2, §7.
 * Export writes inline strings (no sharedStrings table) plus formulas with
 * their last computed values, so Excel shows results immediately and
 * recalculates on open. Import reads cell inputs and formulas, re-evaluates
 * them in our deterministic engine, and — differential-lite — compares our
 * computed values against the stored <v> values from the producing
 * application, reporting mismatches in the LossReport instead of hiding them.
 */

import { LossReport, LossWarning } from "../../document-model/src/serialize";
import { CellFormat, Sheet } from "../../spreadsheet-calc/src/engine";
import { formatAddr, parseAddr } from "../../spreadsheet-calc/src/addr";
import { isError } from "../../spreadsheet-calc/src/types";
import { ZipEntry, zipRead, zipWrite } from "./zip";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------- export ----------

const XLSX_CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
  `</Types>`;

const XLSX_ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const XLSX_WORKBOOK =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const XLSX_WORKBOOK_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `</Relationships>`;

// style indexing: xf index = 1 + fontBit*3 + numFmtIndex (numFmtIndex: 0 none
// is folded into fontBit rows; see styleIndexFor). Custom numFmt ids start at 164.
const NUM_FMT_CODES: Record<string, { id: number; code: string }> = {
  number2: { id: 164, code: "#,##0.00" },
  currency: { id: 165, code: "&quot;$&quot;#,##0.00" },
  percent: { id: 166, code: "0.00%" },
};

/** xf table: [0]=default, then (plain|bold) x (general|number2|currency|percent). */
const XF_NUMFMTS = ["general", "number2", "currency", "percent"] as const;

export function styleIndexFor(format: { bold?: boolean; numFmt?: string } | undefined): number {
  if (!format || (!format.bold && !format.numFmt)) return 0;
  const fontBit = format.bold ? 1 : 0;
  const nf = XF_NUMFMTS.indexOf((format.numFmt ?? "general") as (typeof XF_NUMFMTS)[number]);
  return 1 + fontBit * 4 + Math.max(0, nf);
}

const XLSX_STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="3">` +
  Object.values(NUM_FMT_CODES)
    .map((f) => `<numFmt numFmtId="${f.id}" formatCode="${f.code}"/>`)
    .join("") +
  `</numFmts>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="9">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  [0, 1]
    .map((fontId) =>
      XF_NUMFMTS.map((nf) => {
        const numFmtId = nf === "general" ? 0 : NUM_FMT_CODES[nf]!.id;
        return `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="0" borderId="0" xfId="0" applyFont="${fontId}" applyNumberFormat="${numFmtId ? 1 : 0}"/>`;
      }).join("")
    )
    .join("") +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

function cellXml(addr: string, input: string, sheet: Sheet): string | null {
  const value = sheet.getCell(addr);
  const si = styleIndexFor(sheet.getFormat(addr));
  const sAttr = si > 0 ? ` s="${si}"` : "";
  if (input.startsWith("=")) {
    const f = `<f>${xmlEscape(input.slice(1))}</f>`;
    if (isError(value)) return `<c r="${addr}"${sAttr} t="e">${f}<v>${value.code}</v></c>`;
    if (typeof value === "number") return `<c r="${addr}"${sAttr}>${f}<v>${value}</v></c>`;
    if (typeof value === "boolean") return `<c r="${addr}"${sAttr} t="b">${f}<v>${value ? 1 : 0}</v></c>`;
    if (typeof value === "string")
      return `<c r="${addr}"${sAttr} t="str">${f}<v>${xmlEscape(value)}</v></c>`;
    return `<c r="${addr}"${sAttr}>${f}</c>`;
  }
  if (typeof value === "number") return `<c r="${addr}"${sAttr}><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${addr}"${sAttr} t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === "string")
    return `<c r="${addr}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  if (si > 0) return `<c r="${addr}" s="${si}"/>`; // format on an empty cell
  return null;
}

export async function exportXlsx(sheet: Sheet): Promise<{ bytes: Uint8Array; report: LossReport }> {
  // group non-empty cells by row
  const rows = new Map<number, { col: number; xml: string }[]>();
  for (const { addr, input } of sheet.entries()) {
    const a = parseAddr(addr)!;
    const xml = cellXml(addr, input, sheet);
    if (!xml) continue;
    if (!rows.has(a.row)) rows.set(a.row, []);
    rows.get(a.row)!.push({ col: a.col, xml });
  }
  // rows with a custom height but no cells still need a <row> element
  for (const { row } of sheet.rows()) {
    if (!rows.has(row)) rows.set(row, []);
  }
  const rowXml = [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([r, cells]) => {
      const ht = sheet.getRowHeight(r);
      const htAttr = ht ? ` ht="${ht}" customHeight="1"` : "";
      return `<row r="${r + 1}"${htAttr}>${cells.sort((a, b) => a.col - b.col).map((c) => c.xml).join("")}</row>`;
    })
    .join("");

  const colDefs = sheet.cols();
  const colsXml =
    colDefs.length > 0
      ? `<cols>${colDefs
          .map((c) => `<col min="${c.col + 1}" max="${c.col + 1}" width="${c.width}" customWidth="1"/>`)
          .join("")}</cols>`
      : "";
  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `${colsXml}<sheetData>${rowXml}</sheetData></worksheet>`;

  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: textEncoder.encode(XLSX_CONTENT_TYPES) },
    { name: "_rels/.rels", data: textEncoder.encode(XLSX_ROOT_RELS) },
    { name: "xl/workbook.xml", data: textEncoder.encode(XLSX_WORKBOOK) },
    { name: "xl/_rels/workbook.xml.rels", data: textEncoder.encode(XLSX_WORKBOOK_RELS) },
    { name: "xl/styles.xml", data: textEncoder.encode(XLSX_STYLES) },
    { name: "xl/worksheets/sheet1.xml", data: textEncoder.encode(sheetXml) },
  ];
  // Cell inputs and computed values are fully representable; formatting does
  // not exist in the v0 Sheets model, so there is nothing to lose on export.
  return { bytes: await zipWrite(entries), report: { format: "xlsx", lossless: true, warnings: [] } };
}

// ---------- import ----------

export type XmlParse = (xml: string) => Document;

function defaultParse(xml: string): Document {
  if (typeof DOMParser === "undefined") {
    throw new Error("No XML parser available: pass parseXml to importXlsx");
  }
  return new DOMParser().parseFromString(xml, "application/xml");
}

function descendants(el: Element | Document, name: string): Element[] {
  const out: Element[] = [];
  const walk = (e: Element | Document) => {
    const children = e.children ?? [];
    for (let i = 0; i < children.length; i++) {
      const c = children[i]!;
      if (c.localName === name) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

function firstChild(el: Element, name: string): Element | null {
  for (let i = 0; i < el.children.length; i++) {
    if (el.children[i]!.localName === name) return el.children[i]!;
  }
  return null;
}

export async function importXlsx(
  bytes: Uint8Array,
  parseXml: XmlParse = defaultParse
): Promise<{ sheet: Sheet; report: LossReport }> {
  const warnings: LossWarning[] = [];
  const entries = await zipRead(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const workbookEntry = byName.get("xl/workbook.xml");
  if (!workbookEntry) throw new Error("Not an XLSX package: xl/workbook.xml missing");

  // styles: map s= indexes to the subset of formatting we can represent
  interface XfInfo {
    format: CellFormat;
    dropped: string[];
  }
  const xfTable: XfInfo[] = [];
  const stylesEntry = byName.get("xl/styles.xml");
  if (stylesEntry) {
    try {
      const dom = parseXml(textDecoder.decode(stylesEntry.data));
      const numFmtCodes = new Map<number, string>();
      for (const nf of descendants(dom, "numFmt")) {
        numFmtCodes.set(Number(nf.getAttribute("numFmtId")), nf.getAttribute("formatCode") ?? "");
      }
      const fonts: { bold: boolean; other: string[] }[] = [];
      const fontsEl = descendants(dom, "fonts")[0];
      if (fontsEl) {
        for (const f of descendants(fontsEl, "font")) {
          const names = Array.from(f.children).map((c) => c.localName);
          fonts.push({
            bold: names.includes("b"),
            other: names.filter((n) => ["i", "u", "strike", "color"].includes(n)),
          });
        }
      }
      const BUILTIN_NUMFMT: Record<number, CellFormat["numFmt"]> = {
        2: "number2", 4: "number2", 39: "number2", 40: "number2",
        9: "percent", 10: "percent",
        5: "currency", 6: "currency", 7: "currency", 8: "currency", 44: "currency",
      };
      const classifyNumFmt = (id: number): { fmt?: CellFormat["numFmt"]; dropped?: string } => {
        if (id === 0) return {};
        if (BUILTIN_NUMFMT[id]) return { fmt: BUILTIN_NUMFMT[id] };
        const code = numFmtCodes.get(id);
        if (code !== undefined) {
          if (code.includes("%")) return { fmt: "percent" };
          if (code.includes("$") || code.includes("\u00a4") || code.toLowerCase().includes("[$")) return { fmt: "currency" };
          if (/^#,##0\.0+$|^0\.0+$|^#,##0$/.test(code)) return { fmt: "number2" };
          return { dropped: `number format "${code}"` };
        }
        return { dropped: `number format id ${id}` };
      };
      const cellXfsEl = descendants(dom, "cellXfs")[0];
      if (cellXfsEl) {
        for (const xf of descendants(cellXfsEl, "xf")) {
          const info: XfInfo = { format: {}, dropped: [] };
          const font = fonts[Number(xf.getAttribute("fontId") ?? 0)];
          if (font?.bold) info.format.bold = true;
          if (font && font.other.length > 0) info.dropped.push(...font.other.map((n) => `font ${n}`));
          const nf = classifyNumFmt(Number(xf.getAttribute("numFmtId") ?? 0));
          if (nf.fmt) info.format.numFmt = nf.fmt;
          if (nf.dropped) info.dropped.push(nf.dropped);
          const alignEl = descendants(xf, "alignment")[0];
          const horizontal = alignEl?.getAttribute("horizontal");
          if (horizontal === "left" || horizontal === "center" || horizontal === "right") {
            info.format.align = horizontal;
          }
          if (Number(xf.getAttribute("fillId") ?? 0) > 1) info.dropped.push("fill");
          if (Number(xf.getAttribute("borderId") ?? 0) > 0) info.dropped.push("border");
          xfTable.push(info);
        }
      }
    } catch {
      /* unreadable styles: cells import unformatted; warning fires below if s= is seen */
    }
  }
  const droppedAspects = new Set<string>();

  // shared strings, if the producer used them
  const shared: string[] = [];
  const sst = byName.get("xl/sharedStrings.xml");
  if (sst) {
    const dom = parseXml(textDecoder.decode(sst.data));
    for (const si of descendants(dom, "si")) {
      shared.push(descendants(si, "t").map((t) => t.textContent ?? "").join(""));
    }
  }

  // first worksheet only in v0
  const workbook = parseXml(textDecoder.decode(workbookEntry.data));
  const sheetTags = descendants(workbook, "sheet");
  if (sheetTags.length > 1) {
    warnings.push({
      code: "XLSX-IMPORT-SHEETS",
      message: `Workbook has ${sheetTags.length} sheets; only the first was imported.`,
      blockIndex: -1,
    });
  }
  const wsName =
    [...byName.keys()].find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n)) ??
    [...byName.keys()].find((n) => /^xl\/worksheets\/.*\.xml$/.test(n));
  if (!wsName) throw new Error("XLSX package has no worksheet part");
  const ws = parseXml(textDecoder.decode(byName.get(wsName)!.data));

  const sheet = new Sheet();
  for (const col of descendants(ws, "col")) {
    const min = Number(col.getAttribute("min"));
    const max = Number(col.getAttribute("max"));
    const width = Number(col.getAttribute("width"));
    if (!Number.isFinite(min) || !Number.isFinite(width)) continue;
    for (let c = min; c <= Math.min(max || min, min + 64); c++) {
      sheet.setColWidth(c - 1, width);
    }
  }
  for (const row of descendants(ws, "row")) {
    if (row.getAttribute("customHeight") !== "1") continue;
    const r = Number(row.getAttribute("r"));
    const ht = Number(row.getAttribute("ht"));
    if (Number.isFinite(r) && Number.isFinite(ht) && r >= 1) sheet.setRowHeight(r - 1, ht);
  }
  const pendingFormats: [string, CellFormat][] = [];
  interface Pending {
    addr: string;
    storedValue: string | null;
    type: string;
  }
  const formulas: Pending[] = [];

  for (const c of descendants(ws, "c")) {
    const addr = c.getAttribute("r");
    if (!addr || !parseAddr(addr)) continue;
    const type = c.getAttribute("t") ?? "n";
    const f = firstChild(c, "f");
    const v = firstChild(c, "v");
    const is = firstChild(c, "is");

    const sAttr = c.getAttribute("s");
    if (sAttr !== null) {
      const info = xfTable[Number(sAttr)];
      if (info) {
        if (Object.keys(info.format).length > 0 && addr) pendingFormats.push([addr, info.format]);
        for (const d of info.dropped) droppedAspects.add(d);
      } else if (Number(sAttr) > 0) {
        droppedAspects.add("unresolved style reference");
      }
    }

    if (f && f.textContent) {
      sheet.setCell(addr, "=" + f.textContent);
      formulas.push({ addr, storedValue: v?.textContent ?? null, type });
      continue;
    }
    if (type === "s") {
      const idx = Number(v?.textContent ?? "");
      sheet.setCell(addr, shared[idx] ?? "");
    } else if (type === "inlineStr") {
      sheet.setCell(addr, descendants(is ?? c, "t").map((t) => t.textContent ?? "").join(""));
    } else if (type === "str") {
      sheet.setCell(addr, v?.textContent ?? "");
    } else if (type === "b") {
      sheet.setCell(addr, v?.textContent === "1" ? "TRUE" : "FALSE");
    } else if (type === "e") {
      warnings.push({
        code: "XLSX-IMPORT-ERROR-LITERAL",
        message: `Cell ${addr} held an error literal (${v?.textContent ?? "?"}) with no formula; imported as text.`,
        blockIndex: -1,
      });
      sheet.setCell(addr, v?.textContent ?? "");
    } else if (v?.textContent != null) {
      sheet.setCell(addr, v.textContent);
    }
  }

  for (const [addr, format] of pendingFormats) sheet.setFormat(addr, format);
  if (droppedAspects.size > 0) {
    warnings.push({
      code: "XLSX-IMPORT-STYLES",
      message: `Some cell styling could not be represented and was dropped: ${[...droppedAspects].join(", ")}.`,
      blockIndex: -1,
    });
  }

  // differential-lite: compare our recomputed values with the producer's
  for (const { addr, storedValue, type } of formulas) {
    // null or empty <v>: the producer cached no value (openpyxl does this),
    // so there is nothing to compare against.
    if (storedValue === null || storedValue === "") continue;
    const ours = sheet.getCell(addr);
    let match: boolean;
    if (isError(ours)) {
      match = type === "e" && ours.code === storedValue;
      if (type !== "e") {
        warnings.push({
          code: "XLSX-IMPORT-FORMULA-UNSUPPORTED",
          message: `Formula in ${addr} (${sheet.getInput(addr)}) evaluates to ${ours.code} in Casserole; the source stored ${storedValue}. Likely an unsupported function.`,
          blockIndex: -1,
        });
        continue;
      }
    } else if (typeof ours === "number") {
      match = Math.abs(ours - Number(storedValue)) <= Math.max(1e-9, Math.abs(ours) * 1e-9);
    } else if (typeof ours === "boolean") {
      match = (ours ? "1" : "0") === storedValue || String(ours).toUpperCase() === storedValue;
    } else {
      match = String(ours ?? "") === storedValue;
    }
    if (!match) {
      warnings.push({
        code: "XLSX-IMPORT-VALUE-MISMATCH",
        message: `Cell ${addr}: Casserole computes ${JSON.stringify(isError(ours) ? ours.code : ours)} but the source file stored ${JSON.stringify(storedValue)}.`,
        blockIndex: -1,
      });
    }
  }

  return { sheet, report: { format: "xlsx", lossless: warnings.length === 0, warnings } };
}
