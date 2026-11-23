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

/** Dynamic style table (WO-42B): distinct CellFormats become xf entries. */
export class StyleTable {
  private keys = new Map<string, number>();
  readonly fonts: { bold: boolean; color?: string }[] = [{ bold: false }];
  readonly fills: (string | null)[] = [null, "gray125"];
  readonly borders: boolean[] = [false];
  readonly numFmts = new Map<string, number>(); // code -> id
  readonly xfs: { fontId: number; fillId: number; borderId: number; numFmtId: number; align?: string; wrap?: boolean }[] = [
    { fontId: 0, fillId: 0, borderId: 0, numFmtId: 0 },
  ];
  private nextNumFmtId = 170;

  indexFor(format: CellFormat | undefined): number {
    if (!format || Object.keys(format).length === 0) return 0;
    const key = JSON.stringify([format.bold ?? false, format.color ?? "", format.fill ?? "", format.border ?? false, format.numFmt ?? "", format.decimals ?? "", format.align ?? "", format.wrap ?? false]);
    const hit = this.keys.get(key);
    if (hit !== undefined) return hit;
    // font
    let fontId = this.fonts.findIndex((f) => f.bold === !!format.bold && f.color === format.color);
    if (fontId < 0) { fontId = this.fonts.length; this.fonts.push({ bold: !!format.bold, color: format.color }); }
    // fill
    let fillId = 0;
    if (format.fill) {
      const idx = this.fills.indexOf(format.fill);
      fillId = idx >= 0 ? idx : (this.fills.push(format.fill) - 1);
    }
    // border
    let borderId = 0;
    if (format.border) {
      const idx = this.borders.indexOf(true);
      borderId = idx >= 0 ? idx : (this.borders.push(true) - 1);
    }
    // number format
    let numFmtId = 0;
    const code = numFmtCode(format.numFmt, format.decimals);
    if (code) {
      const existing = this.numFmts.get(code);
      numFmtId = existing ?? this.nextNumFmtId++;
      if (existing === undefined) this.numFmts.set(code, numFmtId);
    }
    const xf: StyleTable["xfs"][number] = { fontId, fillId, borderId, numFmtId };
    if (format.align) xf.align = format.align;
    if (format.wrap) xf.wrap = true;
    const index = this.xfs.push(xf) - 1;
    this.keys.set(key, index);
    return index;
  }

  xml(): string {
    const numFmts = [...this.numFmts.entries()]
      .map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${xmlEscape(code)}"/>`)
      .join("");
    const fonts = this.fonts
      .map((f) => `<font>${f.bold ? "<b/>" : ""}${f.color ? `<color rgb="FF${f.color.replace("#", "").toUpperCase()}"/>` : ""}<sz val="11"/><name val="Calibri"/></font>`)
      .join("");
    const fills = this.fills
      .map((f, i) => {
        if (i === 0) return `<fill><patternFill patternType="none"/></fill>`;
        if (i === 1) return `<fill><patternFill patternType="gray125"/></fill>`;
        return `<fill><patternFill patternType="solid"><fgColor rgb="FF${String(f).replace("#", "").toUpperCase()}"/><bgColor indexed="64"/></patternFill></fill>`;
      })
      .join("");
    const edge = `<left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/>`;
    const borders = this.borders
      .map((b) => (b ? `<border>${edge}</border>` : `<border><left/><right/><top/><bottom/><diagonal/></border>`))
      .join("");
    const xfs = this.xfs
      .map((x, i) => {
        if (i === 0) return `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`;
        const align = x.align || x.wrap
          ? `<alignment${x.align ? ` horizontal="${x.align}"` : ""}${x.wrap ? ` wrapText="1"` : ""}/>`
          : "";
        return `<xf numFmtId="${x.numFmtId}" fontId="${x.fontId}" fillId="${x.fillId}" borderId="${x.borderId}" xfId="0"` +
          `${x.fontId ? ` applyFont="1"` : ""}${x.fillId > 1 ? ` applyFill="1"` : ""}${x.borderId ? ` applyBorder="1"` : ""}` +
          `${x.numFmtId ? ` applyNumberFormat="1"` : ""}${align ? ` applyAlignment="1"` : ""}>${align}</xf>`;
      })
      .join("");
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      (numFmts ? `<numFmts count="${this.numFmts.size}">${numFmts}</numFmts>` : "") +
      `<fonts count="${this.fonts.length}">${fonts}</fonts>` +
      `<fills count="${this.fills.length}">${fills}</fills>` +
      `<borders count="${this.borders.length}">${borders}</borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="${this.xfs.length}">${xfs}</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>`
    );
  }
}

function numFmtCode(fmt: CellFormat["numFmt"], decimals?: number): string | null {
  const d = decimals !== undefined ? Math.max(0, Math.min(10, decimals)) : 2;
  const zeros = d > 0 ? "." + "0".repeat(d) : "";
  switch (fmt) {
    case "number2": return `0${zeros}`;
    case "comma": return `#,##0${zeros}`;
    case "currency": return `"$"#,##0${zeros}`;
    case "percent": return `0${zeros}%`;
    default:
      return decimals !== undefined ? `0${zeros}` : null;
  }
}

function cellXml(addr: string, input: string, sheet: Sheet, styles: StyleTable): string | null {
  const value = sheet.getCell(addr);
  const si = styles.indexFor(sheet.getFormat(addr));
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
  const styles = new StyleTable();
  // group non-empty cells by row
  const rows = new Map<number, { col: number; xml: string }[]>();
  for (const { addr, input } of sheet.entries()) {
    const a = parseAddr(addr)!;
    const xml = cellXml(addr, input, sheet, styles);
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
    { name: "xl/styles.xml", data: textEncoder.encode(styles.xml()) },
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
      const fonts: { bold: boolean; color?: string; other: string[] }[] = [];
      const fontsEl = descendants(dom, "fonts")[0];
      if (fontsEl) {
        for (const f of descendants(fontsEl, "font")) {
          const names = Array.from(f.children).map((c) => c.localName);
          const colorEl = descendants(f, "color")[0];
          const rgb = colorEl?.getAttribute("rgb");
          fonts.push({
            bold: names.includes("b"),
            color: rgb && rgb.length === 8 ? `#${rgb.slice(2).toLowerCase()}` : undefined,
            other: names.filter((n) => ["i", "u", "strike"].includes(n)),
          });
        }
      }
      // fills: index -> solid color
      const fillColors: (string | undefined)[] = [];
      const fillsEl = descendants(dom, "fills")[0];
      if (fillsEl) {
        for (const f of descendants(fillsEl, "fill")) {
          const pf = descendants(f, "patternFill")[0];
          const fg = pf && pf.getAttribute("patternType") === "solid" ? descendants(pf, "fgColor")[0] : null;
          const rgb = fg?.getAttribute("rgb");
          fillColors.push(rgb && rgb.length === 8 ? `#${rgb.slice(2).toLowerCase()}` : undefined);
        }
      }
      // borders: index -> has any edge
      const borderHas: boolean[] = [];
      const bordersEl = descendants(dom, "borders")[0];
      if (bordersEl) {
        for (const b of descendants(bordersEl, "border")) {
          borderHas.push(Array.from(b.children).some((e) => e.getAttribute("style")));
        }
      }
      const BUILTIN_NUMFMT: Record<number, CellFormat["numFmt"]> = {
        2: "number2", 4: "number2", 39: "number2", 40: "number2",
        9: "percent", 10: "percent",
        5: "currency", 6: "currency", 7: "currency", 8: "currency", 44: "currency",
      };
      const classifyNumFmt = (id: number): { fmt?: CellFormat["numFmt"]; decimals?: number; dropped?: string } => {
        if (id === 0) return {};
        if (BUILTIN_NUMFMT[id]) return { fmt: BUILTIN_NUMFMT[id] };
        const code = numFmtCodes.get(id);
        if (code !== undefined) {
          const dec = /\.(0+)/.exec(code)?.[1]?.length ?? 0;
          if (code.includes("%")) return { fmt: "percent", decimals: dec };
          if (code.includes("$") || code.includes("\u00a4") || code.toLowerCase().includes("[$")) return { fmt: "currency", decimals: dec };
          if (/^#,##0(\.0+)?$/.test(code)) return { fmt: "comma", decimals: dec };
          if (/^0(\.0+)?$/.test(code)) return { fmt: "number2", decimals: dec };
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
          if (font?.color) info.format.color = font.color;
          if (font && font.other.length > 0) info.dropped.push(...font.other.map((n) => `font ${n}`));
          const nf = classifyNumFmt(Number(xf.getAttribute("numFmtId") ?? 0));
          if (nf.fmt) info.format.numFmt = nf.fmt;
          if (nf.fmt && nf.decimals !== undefined && nf.decimals !== 2) info.format.decimals = nf.decimals;
          if (nf.dropped) info.dropped.push(nf.dropped);
          const alignEl = descendants(xf, "alignment")[0];
          const horizontal = alignEl?.getAttribute("horizontal");
          if (horizontal === "left" || horizontal === "center" || horizontal === "right") {
            info.format.align = horizontal;
          }
          if (alignEl?.getAttribute("wrapText") === "1") info.format.wrap = true;
          const fillColor = fillColors[Number(xf.getAttribute("fillId") ?? 0)];
          if (fillColor) info.format.fill = fillColor;
          if (borderHas[Number(xf.getAttribute("borderId") ?? 0)]) info.format.border = true;
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
