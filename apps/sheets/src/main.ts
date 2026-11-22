/**
 * Casserole Sheets — Phase 3 vertical slice over engines/spreadsheet-calc.
 * The grid is a renderer; every edit goes through Sheet.setCell, which owns
 * parsing, the dependency graph, and incremental recalculation. Values are
 * always produced by the deterministic engine (§7.4), never by the UI.
 */

import { Sheet } from "../../../engines/spreadsheet-calc/src/engine";
import { colToName, formatAddr, parseAddr } from "../../../engines/spreadsheet-calc/src/addr";
import { isError } from "../../../engines/spreadsheet-calc/src/types";

const COLS = 12;
const ROWS = 40;
const STORAGE_KEY = "casserole-sheets:v1:default";

let sheet = new Sheet();
let selected = "A1";
let editing = false;

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
    const entries = JSON.parse(raw) as { addr: string; input: string }[];
    if (entries.length === 0) return seed();
    for (const { addr, input } of entries) sheet.setCell(addr, input);
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
    td.textContent = sheet.getDisplay(addr);
    td.classList.toggle("error", isError(value));
    td.classList.toggle("num", typeof value === "number");
    td.classList.toggle("selected", addr === selected);
  });
  addrEl.textContent = selected;
  if (!editing) formulaEl.value = sheet.getInput(selected);
}

function select(addr: string): void {
  selected = addr;
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

gridEl.addEventListener("click", (e) => {
  const td = (e.target as HTMLElement).closest("td[data-addr]") as HTMLTableCellElement | null;
  if (td) {
    select(td.dataset.addr!);
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
    select(formatAddr(a));
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
