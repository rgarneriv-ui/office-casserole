/**
 * Casserole Sheets — Phase 3 vertical slice over engines/spreadsheet-calc.
 * The grid is a renderer; every edit goes through Sheet.setCell, which owns
 * parsing, the dependency graph, and incremental recalculation. Values are
 * always produced by the deterministic engine (§7.4), never by the UI.
 */

import { CellFormat, Sheet } from "../../../engines/spreadsheet-calc/src/engine";
import {
  ClipData,
  Rect,
  clearRange,
  copyRange,
  fillRange,
  normalizeRect,
  pasteClip,
  pasteTSV,
  rangeToTSV,
  shiftFormula,
} from "../../../engines/spreadsheet-calc/src/clipboard";
import { colToName, formatAddr, parseAddr } from "../../../engines/spreadsheet-calc/src/addr";
import { isError } from "../../../engines/spreadsheet-calc/src/types";
import { exportXlsx, importXlsx } from "../../../engines/format-conversion/src/xlsx";

const COLS = 12;
const ROWS = 40;
const STORAGE_KEY = "casserole-sheets:v1:default";

let sheet = new Sheet();
let selected = "A1"; // selection focus
let selAnchor = "A1"; // selection anchor (shift-select / drag origin)
let editing = false;
let dragging = false;
let clip: ClipData | null = null;
let fillDrag: { src: Rect; dest: Rect | null } = { src: { r0: 0, c0: 0, r1: 0, c1: 0 }, dest: null };
let fillActive = false;
void shiftFormula;

/** Extra selection areas added with Ctrl/Cmd-click (Excel-style multi-area).
 *  The live anchor..focus rect is always the last, implicit area. */
let selAreas: Rect[] = [];

function allAreas(): Rect[] {
  return [...selAreas, selRect()];
}

function inAnyArea(col: number, row: number): boolean {
  return allAreas().some((a) => inRect(a, col, row));
}

function multiArea(): boolean {
  return selAreas.length > 0;
}

function eachSelected(fn: (addr: string) => void): void {
  const seen = new Set<string>();
  for (const a of allAreas()) {
    eachInRect(a, (addr) => {
      if (!seen.has(addr)) {
        seen.add(addr);
        fn(addr);
      }
    });
  }
}

function selRect(): Rect {
  return normalizeRect(selAnchor, selected);
}

function inRect(rect: Rect, col: number, row: number): boolean {
  return row >= rect.r0 && row <= rect.r1 && col >= rect.c0 && col <= rect.c1;
}

function rangeIsMulti(): boolean {
  const r = selRect();
  return r.r0 !== r.r1 || r.c0 !== r.c1;
}

function eachInRect(rect: Rect, fn: (addr: string) => void): void {
  for (let r = rect.r0; r <= rect.r1; r++) {
    for (let c = rect.c0; c <= rect.c1; c++) fn(formatAddr({ col: c, row: r }));
  }
}

const gridEl = document.getElementById("grid") as HTMLTableElement;
const formulaEl = document.getElementById("formula") as HTMLInputElement;
const addrEl = document.getElementById("addr") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;

// ---------- persistence ----------
let saveTimer: number | null = null;
function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ cells: sheet.entries(), cols: sheet.cols(), rows: sheet.rows() }));
    statusEl.textContent = `Saved ${new Date().toLocaleTimeString()}`;
  } catch {
    statusEl.textContent = "Autosave unavailable — export CSV to keep your work";
  }
}
function scheduleSave(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 500);
}
function restore(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seed();
    const parsed = JSON.parse(raw) as
      | { addr: string; input: string; format?: CellFormat }[]
      | { cells: { addr: string; input: string; format?: CellFormat }[]; cols?: { col: number; width: number }[]; rows?: { row: number; height: number }[] };
    const entries = Array.isArray(parsed) ? parsed : parsed.cells;
    if (!entries || entries.length === 0) return seed();
    for (const e of entries) {
      sheet.setCell(e.addr, e.input);
      if (e.format) sheet.setFormat(e.addr, e.format);
    }
    if (!Array.isArray(parsed) && parsed.cols) {
      for (const c of parsed.cols) sheet.setColWidth(c.col, c.width);
    }
    if (!Array.isArray(parsed) && parsed.rows) {
      for (const r of parsed.rows) sheet.setRowHeight(r.row, r.height);
    }
    statusEl.textContent = "Restored sheet";
  } catch {
    seed();
  }
}
function seed(): void {
  const rows: [string, string, string][] = [
    ["Item", "Qty", "Unit price"],
    ["Paper", "12", "4.5"],
    ["Toner", "2", "89"],
    ["Stapler", "3", "11.25"],
  ];
  rows.forEach((cells, r) => {
    cells.forEach((v, c) => sheet.setCell({ col: c, row: r }, v));
  });
  sheet.setCell("D1", "Line total");
  for (let r = 2; r <= 4; r++) sheet.setCell(`D${r}`, `=B${r}*C${r}`);
  sheet.setCell("A6", "Total");
  sheet.setCell("D6", "=SUM(D2:D4)");
  sheet.setCell("A7", "Average line");
  sheet.setCell("D7", "=ROUND(AVERAGE(D2:D4), 2)");
  sheet.setCell("A8", "Over budget?");
  sheet.setCell("D8", '=IF(D6>300, "YES", "no")');
  for (const a of ["C2", "C3", "C4", "D2", "D3", "D4", "D6", "D7"]) {
    sheet.setFormat(a, { numFmt: "currency" });
  }
  for (const a of ["A1", "B1", "C1", "D1", "A6", "A7", "A8"]) {
    sheet.setFormat(a, { bold: true });
  }
}

// ---------- rendering ----------
const CHAR_PX = 7.5; // px per Excel character-width unit at our font size
const DEFAULT_W = 76;

function colPx(c: number): number {
  const w = sheet.getColWidth(c);
  return w ? Math.max(34, Math.round(w * CHAR_PX)) : DEFAULT_W;
}

const PT_PX = 4 / 3; // px per point at 96dpi
const DEFAULT_ROW_PX = 24;

function rowPx(r: number): number {
  const h = sheet.getRowHeight(r);
  return h ? Math.max(16, Math.round(h * PT_PX)) : DEFAULT_ROW_PX;
}

function applyRowHeights(): void {
  gridEl.querySelectorAll<HTMLTableCellElement>("th[data-row]").forEach((th) => {
    const h = `${rowPx(Number(th.dataset.row))}px`;
    const tr = th.parentElement as HTMLTableRowElement;
    tr.style.height = h;
  });
}

function applyColWidths(): void {
  gridEl.querySelectorAll<HTMLTableCellElement>("th[data-col]").forEach((th) => {
    th.style.minWidth = th.style.maxWidth = `${colPx(Number(th.dataset.col))}px`;
  });
  gridEl.querySelectorAll<HTMLTableCellElement>("td[data-addr]").forEach((td) => {
    const c = parseAddr(td.dataset.addr!)!.col;
    td.style.minWidth = td.style.maxWidth = `${colPx(c)}px`;
  });
}

function buildGrid(): void {
  const head = ["<tr><th></th>"];
  for (let c = 0; c < COLS; c++) {
    head.push(`<th data-col="${c}">${colToName(c)}<span class="col-grip" data-grip="${c}"></span></th>`);
  }
  head.push("</tr>");
  const rows: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    const cells = [`<th data-row="${r}">${r + 1}<span class="row-grip" data-rowgrip="${r}"></span></th>`];
    for (let c = 0; c < COLS; c++) {
      cells.push(`<td data-addr="${formatAddr({ col: c, row: r })}"></td>`);
    }
    rows.push(`<tr>${cells.join("")}</tr>`);
  }
  gridEl.innerHTML = `<thead>${head.join("")}</thead><tbody>${rows.join("")}</tbody>`;
}

function refreshValues(): void {
  gridEl.querySelectorAll<HTMLTableCellElement>("td[data-addr]").forEach((td) => {
    const addr = td.dataset.addr!;
    const value = sheet.getCell(addr);
    const fmt = sheet.getFormat(addr);
    const a = parseAddr(addr)!;
    td.textContent = sheet.getDisplay(addr);
    td.classList.toggle("error", isError(value));
    td.classList.toggle("num", typeof value === "number");
    td.classList.toggle("selected", addr === selected);
    td.classList.toggle("in-range", (rangeIsMulti() || multiArea()) && inAnyArea(a.col, a.row));
    td.classList.toggle("fill-preview", fillActive && fillDrag.dest !== null && inRect(fillDrag.dest, a.col, a.row));
    td.classList.toggle("bold", fmt.bold === true);
    td.style.textAlign = fmt.align ?? "";
  });
  // fill grip on the bottom-right cell of the selection
  gridEl.querySelectorAll(".fill-grip").forEach((el) => el.remove());
  const rr = selRect();
  const corner = gridEl.querySelector(
    `td[data-addr="${formatAddr({ col: rr.c1, row: rr.r1 })}"]`
  ) as HTMLTableCellElement | null;
  if (corner && !editing && !multiArea()) {
    const grip = document.createElement("span");
    grip.className = "fill-grip";
    corner.appendChild(grip);
  }
  applyColWidths();
  applyRowHeights();
  const r = selRect();
  addrEl.textContent = multiArea()
    ? `${allAreas().length} areas`
    : rangeIsMulti()
      ? `${formatAddr({ col: r.c0, row: r.r0 })}:${formatAddr({ col: r.c1, row: r.r1 })}`
      : selected;
  if (!editing) formulaEl.value = sheet.getInput(selected);
  syncFormatToolbar();
}

function syncFormatToolbar(): void {
  const fmt = sheet.getFormat(selected);
  document.getElementById("btn-bold")?.classList.toggle("active", fmt.bold === true);
  const numSel = document.getElementById("fmt-num") as HTMLSelectElement | null;
  if (numSel) numSel.value = fmt.numFmt ?? "general";
  const alignSel = document.getElementById("fmt-align") as HTMLSelectElement | null;
  if (alignSel) alignSel.value = fmt.align ?? "auto";
}

document.getElementById("btn-bold")?.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const turnOn = !sheet.getFormat(selected).bold;
  eachSelected((addr) => sheet.setFormat(addr, { bold: turnOn ? true : null }));
  refreshValues();
  scheduleSave();
});
document.getElementById("fmt-num")?.addEventListener("change", (e) => {
  const v = (e.target as HTMLSelectElement).value;
  eachSelected((addr) => sheet.setFormat(addr, { numFmt: v }));
  refreshValues();
  scheduleSave();
  formulaEl.focus();
});
document.getElementById("fmt-align")?.addEventListener("change", (e) => {
  const v = (e.target as HTMLSelectElement).value;
  eachSelected((addr) => sheet.setFormat(addr, { align: v === "auto" ? null : v }));
  refreshValues();
  scheduleSave();
  formulaEl.focus();
});

function select(addr: string, extend = false, addArea = false): void {
  if (addArea) {
    selAreas.push(selRect());
  } else if (!extend) {
    selAreas = [];
  }
  selected = addr;
  if (!extend) selAnchor = addr;
  editing = false;
  refreshValues();
}

// ---------- editing ----------
function commit(input: string, move: "down" | "right" | "none"): void {
  sheet.setCell(selected, input);
  editing = false;
  const a = parseAddr(selected)!;
  if (move === "down" && a.row < ROWS - 1) selected = formatAddr({ col: a.col, row: a.row + 1 });
  if (move === "right" && a.col < COLS - 1) selected = formatAddr({ col: a.col + 1, row: a.row });
  refreshValues();
  scheduleSave();
}

gridEl.addEventListener("pointerdown", (e) => {
  if ((e.target as HTMLElement).classList.contains("fill-grip")) {
    fillActive = true;
    fillDrag = { src: selRect(), dest: null };
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const td = (e.target as HTMLElement).closest("td[data-addr]") as HTMLTableCellElement | null;
  if (!td) return;
  select(td.dataset.addr!, e.shiftKey, (e.ctrlKey || e.metaKey) && !e.shiftKey);
  dragging = true;
  e.preventDefault();
});
gridEl.addEventListener("pointerover", (e) => {
  const td = (e.target as HTMLElement).closest("td[data-addr]") as HTMLTableCellElement | null;
  if (fillActive) {
    if (!td) return;
    const a = parseAddr(td.dataset.addr!)!;
    const src = fillDrag.src;
    // dominant axis: below → fill down; right → fill right
    if (a.row > src.r1) {
      fillDrag.dest = { r0: src.r1 + 1, c0: src.c0, r1: a.row, c1: src.c1 };
    } else if (a.col > src.c1) {
      fillDrag.dest = { r0: src.r0, c0: src.c1 + 1, r1: src.r1, c1: a.col };
    } else {
      fillDrag.dest = null;
    }
    refreshValues();
    return;
  }
  if (!dragging) return;
  if (td && td.dataset.addr !== selected) select(td.dataset.addr!, true);
});
document.addEventListener("pointerup", () => {
  if (fillActive) {
    fillActive = false;
    if (fillDrag.dest) {
      fillRange(sheet, fillDrag.src, fillDrag.dest);
      // extend the selection over the filled area
      selAnchor = formatAddr({ col: fillDrag.src.c0, row: fillDrag.src.r0 });
      selected = formatAddr({ col: fillDrag.dest.c1, row: fillDrag.dest.r1 });
      statusEl.textContent = "Filled";
      scheduleSave();
    }
    fillDrag.dest = null;
    refreshValues();
    formulaEl.focus();
    return;
  }
  if (dragging) {
    dragging = false;
    formulaEl.focus();
    formulaEl.select();
  }
});

formulaEl.addEventListener("input", () => {
  editing = true;
});
formulaEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    commit(formulaEl.value, "down");
    formulaEl.focus();
  } else if (e.key === "Tab") {
    e.preventDefault();
    commit(formulaEl.value, "right");
    formulaEl.focus();
  } else if (e.key === "Escape") {
    editing = false;
    refreshValues();
  } else if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key) && !editing) {
    const a = parseAddr(selected)!;
    if (e.key === "ArrowDown" && a.row < ROWS - 1) a.row++;
    if (e.key === "ArrowUp" && a.row > 0) a.row--;
    if (e.key === "ArrowRight" && a.col < COLS - 1) a.col++;
    if (e.key === "ArrowLeft" && a.col > 0) a.col--;
    e.preventDefault();
    select(formatAddr(a), e.shiftKey);
  } else if ((e.key === "Delete" || e.key === "Backspace") && !editing && (rangeIsMulti() || multiArea())) {
    e.preventDefault();
    for (const area of allAreas()) clearRange(sheet, area);
    refreshValues();
    scheduleSave();
  } else if ((e.ctrlKey || e.metaKey) && !editing && ["c", "x", "v"].includes(e.key.toLowerCase())) {
    const k = e.key.toLowerCase();
    e.preventDefault();
    if ((k === "c" || k === "x") && multiArea()) {
      // Excel refuses too: disjoint areas have no rectangular clip shape
      statusEl.textContent = "Can't copy a multi-area selection";
      return;
    }
    if (k === "c" || k === "x") {
      clip = copyRange(sheet, selRect());
      try {
        void navigator.clipboard?.writeText(rangeToTSV(sheet, selRect()));
      } catch { /* clipboard write unavailable (sandbox) */ }
      if (k === "x") {
        clearRange(sheet, selRect());
        scheduleSave();
      }
      statusEl.textContent = `${k === "x" ? "Cut" : "Copied"} ${clip.rows}\u00d7${clip.cols}`;
      refreshValues();
    } else {
      if (clip) {
        pasteClip(sheet, clip, formatAddr({ col: selRect().c0, row: selRect().r0 }));
        refreshValues();
        scheduleSave();
        statusEl.textContent = "Pasted (formulas rebased)";
      } else if (navigator.clipboard?.readText) {
        navigator.clipboard.readText().then((text) => {
          if (!text) return;
          pasteTSV(sheet, text, formatAddr({ col: selRect().c0, row: selRect().r0 }));
          refreshValues();
          scheduleSave();
          statusEl.textContent = "Pasted values from clipboard";
        }).catch(() => {
          statusEl.textContent = "Clipboard read unavailable here";
        });
      }
    }
  }
});

// ---------- column resize ----------
let gripDrag: { col: number; startX: number; startPx: number } | null = null;
let rowGripDrag: { row: number; startY: number; startPx: number } | null = null;
gridEl.addEventListener("pointerdown", (e) => {
  const rowGrip = (e.target as HTMLElement).closest(".row-grip") as HTMLElement | null;
  if (rowGrip) {
    e.preventDefault();
    e.stopPropagation();
    const row = Number(rowGrip.dataset.rowgrip);
    rowGripDrag = { row, startY: e.clientY, startPx: rowPx(row) };
    return;
  }
  const grip = (e.target as HTMLElement).closest(".col-grip") as HTMLElement | null;
  if (!grip) return;
  e.preventDefault();
  e.stopPropagation();
  const col = Number(grip.dataset.grip);
  gripDrag = { col, startX: e.clientX, startPx: colPx(col) };
});
document.addEventListener("pointermove", (e) => {
  if (rowGripDrag) {
    const px = Math.max(16, rowGripDrag.startPx + (e.clientY - rowGripDrag.startY));
    sheet.setRowHeight(rowGripDrag.row, px / PT_PX);
    applyRowHeights();
    return;
  }
  if (!gripDrag) return;
  const px = Math.max(34, gripDrag.startPx + (e.clientX - gripDrag.startX));
  sheet.setColWidth(gripDrag.col, px / CHAR_PX);
  applyColWidths();
});
document.addEventListener("pointerup", () => {
  if (rowGripDrag) {
    rowGripDrag = null;
    scheduleSave();
  }
  if (gripDrag) {
    gripDrag = null;
    scheduleSave();
  }
});

// ---------- export ----------
declare global {
  interface Window {
    claude?: { use: (name: string) => Promise<{ save: (o: { filename: string; data: Blob | string }) => Promise<unknown> } | null> };
  }
}
let hostDownloads: { save: (o: { filename: string; data: Blob | string }) => Promise<unknown> } | null = null;
if (window.claude?.use) {
  window.claude.use("downloads").then((d) => { hostDownloads = d; }).catch(() => {});
}

function csvEscape(text: string): string {
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

document.getElementById("btn-export-csv")?.addEventListener("click", async () => {
  let maxRow = 0;
  let maxCol = 0;
  for (const { addr } of sheet.entries()) {
    const a = parseAddr(addr)!;
    maxRow = Math.max(maxRow, a.row);
    maxCol = Math.max(maxCol, a.col);
  }
  const lines: string[] = [];
  for (let r = 0; r <= maxRow; r++) {
    const cells: string[] = [];
    for (let c = 0; c <= maxCol; c++) {
      cells.push(csvEscape(sheet.getDisplay(formatAddr({ col: c, row: r }))));
    }
    lines.push(cells.join(","));
  }
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv" });
  if (hostDownloads) {
    try {
      await hostDownloads.save({ filename: "sheet.csv", data: blob });
      return;
    } catch { /* fall through */ }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "sheet.csv";
  a.click();
  URL.revokeObjectURL(a.href);
});

async function deliverBlob(filename: string, blob: Blob): Promise<void> {
  if (hostDownloads) {
    try {
      await hostDownloads.save({ filename, data: blob });
      return;
    } catch { /* fall through */ }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

document.getElementById("btn-export-xlsx")?.addEventListener("click", async () => {
  try {
    const { bytes } = await exportXlsx(sheet);
    await deliverBlob(
      "sheet.xlsx",
      new Blob([bytes as BlobPart], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      })
    );
  } catch (err) {
    statusEl.textContent = `⚠ XLSX export failed: ${err instanceof Error ? err.message : String(err)}`;
  }
});

document.getElementById("btn-open")?.addEventListener("click", () => {
  (document.getElementById("file-open") as HTMLInputElement | null)?.click();
});
document.getElementById("file-open")?.addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const { sheet: imported, report } = await importXlsx(new Uint8Array(await file.arrayBuffer()));
    sheet = imported;
    selected = "A1";
    refreshValues();
    scheduleSave();
    if (report.lossless) {
      statusEl.textContent = "Imported XLSX — no loss detected for this workbook";
    } else {
      statusEl.textContent = `Imported XLSX with ${report.warnings.length} note(s)`;
      window.alert(
        "Import loss report:\n\n" + [...new Set(report.warnings.map((w) => `• ${w.message}`))].join("\n")
      );
    }
  } catch (err) {
    statusEl.textContent = `⚠ Import failed: ${err instanceof Error ? err.message : String(err)}`;
  }
});

document.getElementById("btn-clear")?.addEventListener("click", () => {
  if (!window.confirm("Clear the whole sheet? This cannot be undone.")) return;
  sheet = new Sheet();
  refreshValues();
  scheduleSave();
});

// ---------- boot ----------
buildGrid();
restore();
refreshValues();
formulaEl.focus();

// ---------- ribbon (WO-39) ----------
import { buildRibbon } from "../../shared/ribbon";

/** Clipboard buttons reuse the real keyboard path on the formula bar. */
function sendClipKey(key: string): void {
  formulaEl.dispatchEvent(
    new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true })
  );
}

buildRibbon(
  document.getElementById("ribbon") as HTMLElement,
  [
    {
      name: "Home",
      groups: [
        {
          name: "Clipboard",
          controls: [
            { kind: "action", label: "Paste", icon: "📋", big: true, title: "Paste (Ctrl/Cmd-V)", onClick: () => sendClipKey("v") },
            { kind: "action", label: "Cut", icon: "✂", title: "Cut (Ctrl/Cmd-X)", onClick: () => sendClipKey("x") },
            { kind: "action", label: "Copy", icon: "⿻", title: "Copy (Ctrl/Cmd-C)", onClick: () => sendClipKey("c") },
            { kind: "ph", label: "Format Painter", icon: "🖌" },
          ],
        },
        {
          name: "Font",
          controls: [
            { kind: "ph", label: "Calibri" },
            { kind: "ph", label: "11" },
            { kind: "move", id: "btn-bold" },
            { kind: "ph", label: "I" },
            { kind: "ph", label: "U" },
            { kind: "ph", label: "Borders", icon: "⊞" },
            { kind: "ph", label: "Fill Color", icon: "🪣" },
            { kind: "ph", label: "Font Color", icon: "A" },
          ],
        },
        {
          name: "Alignment",
          controls: [
            { kind: "move", id: "fmt-align" },
            { kind: "ph", label: "Wrap Text" },
            { kind: "ph", label: "Merge & Center" },
          ],
        },
        {
          name: "Number",
          controls: [
            { kind: "move", id: "fmt-num" },
            { kind: "ph", label: ",", icon: "" },
            { kind: "ph", label: ".00→.0" },
            { kind: "ph", label: ".0→.00" },
          ],
        },
        {
          name: "Cells",
          controls: [
            { kind: "ph", label: "Insert", icon: "⊕" },
            { kind: "ph", label: "Delete", icon: "⊖" },
            { kind: "ph", label: "Format", icon: "▤" },
          ],
        },
        {
          name: "Editing",
          controls: [
            { kind: "action", label: "AutoSum", icon: "Σ", title: "Start a =SUM( formula in the formula bar", onClick: () => {
              formulaEl.value = "=SUM(";
              formulaEl.dispatchEvent(new Event("input", { bubbles: true }));
              formulaEl.focus();
            } },
            { kind: "move", id: "btn-clear", label: "Clear" },
            { kind: "ph", label: "Sort & Filter", icon: "⇅" },
            { kind: "ph", label: "Find & Select", icon: "🔍" },
          ],
        },
      ],
    },
    {
      name: "Insert",
      groups: [
        { name: "Tables", controls: [{ kind: "ph", label: "PivotTable", big: true, icon: "▦" }, { kind: "ph", label: "Table", big: true, icon: "⊞" }] },
        { name: "Charts", controls: [{ kind: "ph", label: "Recommended\nCharts", big: true, icon: "📊" }, { kind: "ph", label: "Column" }, { kind: "ph", label: "Line" }, { kind: "ph", label: "Pie" }] },
        { name: "Sparklines", controls: [{ kind: "ph", label: "Line" }, { kind: "ph", label: "Column" }] },
      ],
    },
    {
      name: "Formulas",
      groups: [
        {
          name: "Function Library",
          controls: [
            { kind: "action", label: "Insert\nFunction", big: true, icon: "ƒx", title: "Start a formula in the formula bar", onClick: () => {
              formulaEl.value = "=";
              formulaEl.dispatchEvent(new Event("input", { bubbles: true }));
              formulaEl.focus();
            } },
            { kind: "ph", label: "Financial" },
            { kind: "ph", label: "Logical" },
            { kind: "ph", label: "Text" },
            { kind: "ph", label: "Date & Time" },
            { kind: "ph", label: "Lookup" },
          ],
        },
        { name: "Calculation", controls: [{ kind: "ph", label: "Calculate Now" }] },
      ],
    },
    {
      name: "File",
      groups: [
        { name: "Workbook", controls: [{ kind: "move", id: "btn-open", label: "Open", icon: "📂", big: true }] },
        {
          name: "Export",
          controls: [
            { kind: "move", id: "btn-export-xlsx", label: "Excel\n(.xlsx)", icon: "⬇", big: true },
            { kind: "move", id: "btn-export-csv", label: "CSV", icon: "⬇", big: true },
          ],
        },
      ],
    },
  ],
  []
);
