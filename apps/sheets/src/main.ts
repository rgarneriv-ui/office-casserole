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
void shiftFormula;

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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sheet.entries()));
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
    const entries = JSON.parse(raw) as { addr: string; input: string; format?: CellFormat }[];
    if (entries.length === 0) return seed();
    for (const e of entries) {
      sheet.setCell(e.addr, e.input);
      if (e.format) sheet.setFormat(e.addr, e.format);
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
function buildGrid(): void {
  const head = ["<tr><th></th>"];
  for (let c = 0; c < COLS; c++) head.push(`<th>${colToName(c)}</th>`);
  head.push("</tr>");
  const rows: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    const cells = [`<th>${r + 1}</th>`];
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
    td.classList.toggle("in-range", rangeIsMulti() && inRect(selRect(), a.col, a.row));
    td.classList.toggle("bold", fmt.bold === true);
    td.style.textAlign = fmt.align ?? "";
  });
  const r = selRect();
  addrEl.textContent = rangeIsMulti()
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
  eachInRect(selRect(), (addr) => sheet.setFormat(addr, { bold: turnOn ? true : null }));
  refreshValues();
  scheduleSave();
});
document.getElementById("fmt-num")?.addEventListener("change", (e) => {
  const v = (e.target as HTMLSelectElement).value;
  eachInRect(selRect(), (addr) => sheet.setFormat(addr, { numFmt: v }));
  refreshValues();
  scheduleSave();
  formulaEl.focus();
});
document.getElementById("fmt-align")?.addEventListener("change", (e) => {
  const v = (e.target as HTMLSelectElement).value;
  eachInRect(selRect(), (addr) => sheet.setFormat(addr, { align: v === "auto" ? null : v }));
  refreshValues();
  scheduleSave();
  formulaEl.focus();
});

function select(addr: string, extend = false): void {
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
  const td = (e.target as HTMLElement).closest("td[data-addr]") as HTMLTableCellElement | null;
  if (!td) return;
  select(td.dataset.addr!, e.shiftKey);
  dragging = true;
  e.preventDefault();
});
gridEl.addEventListener("pointerover", (e) => {
  if (!dragging) return;
  const td = (e.target as HTMLElement).closest("td[data-addr]") as HTMLTableCellElement | null;
  if (td && td.dataset.addr !== selected) select(td.dataset.addr!, true);
});
document.addEventListener("pointerup", () => {
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
  } else if ((e.key === "Delete" || e.key === "Backspace") && !editing && rangeIsMulti()) {
    e.preventDefault();
    clearRange(sheet, selRect());
    refreshValues();
    scheduleSave();
  } else if ((e.ctrlKey || e.metaKey) && !editing && ["c", "x", "v"].includes(e.key.toLowerCase())) {
    const k = e.key.toLowerCase();
    e.preventDefault();
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
