/**
 * Casserole Write — Phase 2 vertical slice.
 * All editing routes through the unified command dispatch (§18.2): the
 * contenteditable surface is a renderer + input source; the document model is
 * the single source of truth. Autosave journals to localStorage (ADR-0001
 * records this as the browser-slice stand-in for the local durable store).
 */

import {
  Block,
  DocModel,
  TableEdit,
  editTable,
  insertTable,
  removeTable,
  setTableCell,
  setTableStyle,
  DocRange,
  TransactionLog,
  applyOp,
  Mark,
  Position,
  blockText,
  clampPosition,
  deleteRange,
  findMatches,
  replaceAll,
  replaceMatch,
  fromJSON,
  insertText,
  inspect,
  applyCodeAction,
  explainAt,
  isCollapsed,
  marksAt,
  mergeWithPrevious,
  newDocument,
  normRange,
  rangeHasMark,
  setBlockType,
  setListIndent,
  splitBlock,
  toggleMark,
  toHTML,
  toJSON,
  toMarkdown,
  validateModel,
} from "../../../engines/document-model/src/index";
import type { TextMatch } from "../../../engines/document-model/src/index";

import { DocumentStore, StoredRevision, newDocId, openBestStore } from "./store";
import { diffBlockText, diffModels, diffSummary } from "../../../engines/document-model/src/diff";
import { BULLET_GLYPHS, ListCounter } from "../../../engines/document-model/src/listmarks";
import { DocumentJournal, OpTransaction } from "../../../engines/document-model/src/journal";
import { PrimOp } from "../../../engines/document-model/src/oplog";
import { CommandDefinition } from "../../../packages/shared-types/src/resource";
import { PreservedPart, exportDocx, importDocx } from "../../../engines/format-conversion/src/docx";
import { exportPdf } from "../../../engines/pdf-engine/src/pdf";

const BLOCK_TAG: Record<string, string> = { paragraph: "p", heading1: "h1", heading2: "h2" };

// ---------- state ----------
let model: DocModel = newDocument();
let selection: DocRange = { anchor: { block: 0, offset: 0 }, focus: { block: 0, offset: 0 } };
let caretMarks: Mark[] | null = null; // pending marks for a collapsed caret
let activeTableBlock: number | null = null;
let activeTableCol = 0;
let listLabels: string[] = [];
const log = new TransactionLog();

// ---------- authorship + journal (§14.1, live wiring per ADR-0010) ----------
function initActorId(): string {
  try {
    const existing = localStorage.getItem("casserole:actor");
    if (existing) return existing;
    const fresh = `local-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem("casserole:actor", fresh);
    return fresh;
  } catch {
    return "local";
  }
}
const actorId = initActorId();
let journal: DocumentJournal | null = null;

log.onCommit((txn) => {
  try {
    journal?.append(actorId, txn.ops);
  } catch (err) {
    console.error("journal append failed:", err);
  }
});

function snapModel(m: DocModel): string {
  return JSON.stringify(JSON.parse(toJSON(m)));
}
let saveTimer: number | null = null;
let recovered = false;

const editor = document.getElementById("editor") as HTMLElement;
const codesPanel = document.getElementById("codes") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const explainEl = document.getElementById("explain") as HTMLElement;
const titleEl = document.getElementById("doc-title") as HTMLInputElement | null;
const docListEl = document.getElementById("doc-list") as HTMLSelectElement | null;

// ---------- persistence (multi-document store, autosave + crash recovery) ----------
let store: DocumentStore | null = null;
let currentDocId = "";
let currentTitle = "Untitled document";
let dirtySinceSave = false;

function durabilityNote(): string {
  if (!store) return "";
  if (store.durability === "memory-only") return " (⚠ memory only — export to keep)";
  if (store.durability === "session") return " (localStorage)";
  return "";
}

let revisions: StoredRevision[] = [];
let preservedDocx: PreservedPart[] = [];

function b64FromBytes(data: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < data.length; i += CHUNK) {
    bin += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function bytesFromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function save(): Promise<void> {
  if (!store) return;
  try {
    log.flush(); // close the open transaction so the journal is current
    if (journal && journal.size() > 300) {
      const entries = journal.list();
      journal.compact(entries[entries.length - 150]!.seq - 1);
    }
    currentTitle = (titleEl?.value || "Untitled document").trim() || "Untitled document";
    await store.save({
      id: currentDocId,
      title: currentTitle,
      updatedAt: new Date().toISOString(),
      doc: JSON.parse(toJSON(model)),
      revisions,
      journal: journal?.toJSON(),
      preservedDocx: preservedDocx.length
        ? preservedDocx.map((p) => ({ name: p.name, b64: b64FromBytes(p.data) }))
        : undefined,
    });
    dirtySinceSave = false;
    statusEl.textContent = `Saved ${new Date().toLocaleTimeString()}${durabilityNote()}`;
    void refreshDocList();
  } catch {
    statusEl.textContent = "⚠ Autosave failed — export to keep this document";
  }
}

function scheduleSave(): void {
  dirtySinceSave = true;
  statusEl.textContent = "Editing…";
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void save(), 500);
}

// ---------- selection mapping (DOM <-> model) ----------
function domPointToPosition(node: Node, domOffset: number): Position | null {
  let el: Node | null = node;
  while (el && el !== editor && !(el instanceof HTMLElement && el.dataset.block !== undefined)) {
    el = el.parentNode;
  }
  if (!el || el === editor) {
    // Clicked the editor background: snap to end of last block.
    const last = model.blocks.length - 1;
    return { block: last, offset: blockText(model.blocks[last]!).length };
  }
  const blockEl = el as HTMLElement;
  const blockIndex = Number(blockEl.dataset.block);
  let offset = 0;
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  let t: Node | null = walker.nextNode();
  while (t) {
    if (t === node) {
      offset += domOffset;
      return clampPosition(model, { block: blockIndex, offset });
    }
    offset += (t.textContent ?? "").length;
    t = walker.nextNode();
  }
  // node was the block element itself (e.g. empty block)
  if (node === blockEl) {
    const children = Array.from(blockEl.childNodes);
    let o = 0;
    for (let i = 0; i < Math.min(domOffset, children.length); i++) {
      o += children[i]!.textContent?.length ?? 0;
    }
    return clampPosition(model, { block: blockIndex, offset: o });
  }
  return clampPosition(model, { block: blockIndex, offset });
}

function readSelection(): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const anchor = sel.anchorNode ? domPointToPosition(sel.anchorNode, sel.anchorOffset) : null;
  const focus = sel.focusNode ? domPointToPosition(sel.focusNode, sel.focusOffset) : null;
  if (anchor && focus) {
    const moved =
      anchor.block !== selection.anchor.block || anchor.offset !== selection.anchor.offset ||
      focus.block !== selection.focus.block || focus.offset !== selection.focus.offset;
    selection = { anchor, focus };
    if (moved) caretMarks = null;
    updateToolbar();
    updateExplain();
  }
}

function positionToDomPoint(pos: Position): { node: Node; offset: number } {
  const blockEl = editor.querySelector(`[data-block="${pos.block}"]`) as HTMLElement | null;
  if (!blockEl) return { node: editor, offset: 0 };
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  let remaining = pos.offset;
  let t: Node | null = walker.nextNode();
  let lastText: Node | null = null;
  while (t) {
    const len = (t.textContent ?? "").length;
    if (remaining <= len) return { node: t, offset: remaining };
    remaining -= len;
    lastText = t;
    t = walker.nextNode();
  }
  if (lastText) return { node: lastText, offset: (lastText.textContent ?? "").length };
  return { node: blockEl, offset: 0 };
}

function writeSelection(): void {
  const sel = window.getSelection();
  if (!sel) return;
  const a = positionToDomPoint(clampPosition(model, selection.anchor));
  const f = positionToDomPoint(clampPosition(model, selection.focus));
  const range = document.createRange();
  try {
    sel.removeAllRanges();
    range.setStart(a.node, a.offset);
    sel.addRange(range);
    sel.extend(f.node, f.offset);
  } catch {
    /* defensive: never let selection restore break editing */
  }
}

// ---------- rendering ----------
function renderBlock(block: Block, index: number): string {
  if (block.type === "table" && block.table) {
    const style = block.tableStyle ?? {};
    const cols = block.table[0]!.length;
    const weights = style.widths ?? new Array<number>(cols).fill(1);
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const colgroup = `<colgroup>${weights
      .map((w) => `<col style="width:${((w / weightSum) * 100).toFixed(1)}%">`)
      .join("")}</colgroup>`;
    const rows = block.table
      .map(
        (row, r) =>
          `<tr>${row
            .map((cell, c) => {
              const tag = style.headerRow && r === 0 ? "th" : "td";
              const align = style.aligns?.[c] ? ` style="text-align:${style.aligns[c]}"` : "";
              return `<${tag} data-r="${r}" data-c="${c}"${align}>${cell
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/\n/g, "<br>") || "&nbsp;"}</${tag}>`;
            })
            .join("")}</tr>`
      )
      .join("");
    const controls =
      activeTableBlock === index
        ? `<div class="tbl-controls" contenteditable="false">` +
          `<button data-tedit="add-row">+ Row</button><button data-tedit="remove-row">− Row</button>` +
          `<button data-tedit="add-col">+ Col</button><button data-tedit="remove-col">− Col</button>` +
          `<button data-tedit="header" class="${style.headerRow ? "on" : ""}">Header</button>` +
          `<button data-tedit="align" title="Cycle alignment of the last-clicked column">Align col</button>` +
          `<button data-tedit="wider" title="Widen the last-clicked column">⟷+</button>` +
          `<button data-tedit="narrower" title="Narrow the last-clicked column">⟷−</button>` +
          `<button data-tedit="delete">✕ Table</button></div>`
        : "";
    return `<div class="tbl-wrap" contenteditable="false" data-block="${index}"><table class="cas-table">${colgroup}${rows}</table>${controls}</div>`;
  }
  const tag = BLOCK_TAG[block.type] ?? "p";
  const isListBlock = block.type === "bullet" || block.type === "numbered";
  const listCls = isListBlock
    ? ` class="li-item" data-label="${listLabels[index] ?? ""}" style="margin-left:${34 + (Math.min(3, block.indent ?? 0)) * 26}px"`
    : "";
  const inner =
    block.runs
      .map((run) => {
        let cls = run.marks.map((m) => `m-${m}`).join(" ");
        const text = run.text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return cls ? `<span class="${cls}">${text}</span>` : `<span>${text}</span>`;
      })
      .join("") || "<br>";
  return `<${tag}${listCls} data-block="${index}">${inner}</${tag}>`;
}

function render(): void {
  const lc = new ListCounter();
  listLabels = model.blocks.map((b) => {
    const lvl = Math.min(3, b.indent ?? 0);
    const marker = lc.next(b.type, lvl);
    if (b.type === "bullet") return BULLET_GLYPHS[lvl]!;
    return marker ?? "";
  });
  editor.innerHTML = model.blocks.map(renderBlock).join("");
  writeSelection();
  renderCodes();
  updateToolbar();
  const errors = validateModel(model);
  if (errors.length > 0) {
    // Fail loudly in the slice rather than silently corrupting (§1.2.5).
    console.error("MODEL INVARIANT VIOLATION:", errors);
    statusEl.textContent = "⚠ internal model error — see console";
  }
}

const BLOCK_CYCLE: Record<string, Block["type"]> = {
  paragraph: "heading1",
  heading1: "heading2",
  heading2: "bullet",
  bullet: "numbered",
  numbered: "paragraph",
};

function renderCodes(): void {
  const codes = inspect(model);
  codesPanel.innerHTML = codes
    .map((c, i) => {
      const cls =
        c.kind === "text" ? "code-text" : c.kind.startsWith("mark") ? "code-mark" : "code-block";
      const label =
        c.kind === "text"
          ? c.label.replace(/&/g, "&amp;").replace(/</g, "&lt;")
          : c.label;
      const actions =
        c.kind === "mark-on" || c.kind === "mark-off"
          ? `<button class="code-x" data-x="${i}" title="Remove this formatting span (§6.2.3)">×</button>`
          : c.kind === "block-start"
            ? `<button class="code-x code-cycle" data-cycle="${i}" title="Change block type">↻</button>`
            : "";
      return `<span class="code ${cls}" data-code="${i}" title="block ${c.blockIndex + 1}, chars ${c.start}–${c.end}">${label}${actions}</span>`;
    })
    .join("");
  codesPanel.querySelectorAll<HTMLButtonElement>(".code-x").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const codes2 = inspect(model);
      if (btn.dataset.x !== undefined) {
        const c = codes2[Number(btn.dataset.x)];
        if (!c) return;
        log.begin();
        const msg = applyCodeAction(model, c, { kind: "remove-mark" }, log);
        if (msg) {
          statusEl.textContent = msg;
          render();
          scheduleSave();
        }
      } else if (btn.dataset.cycle !== undefined) {
        const c = codes2[Number(btn.dataset.cycle)];
        if (!c) return;
        const next = BLOCK_CYCLE[model.blocks[c.blockIndex]?.type ?? "paragraph"]!;
        log.begin();
        const msg = applyCodeAction(model, c, { kind: "set-block-type", blockType: next }, log);
        if (msg) {
          statusEl.textContent = msg;
          render();
          scheduleSave();
        }
      }
    });
  });
  codesPanel.querySelectorAll<HTMLElement>(".code").forEach((el) => {
    el.addEventListener("click", () => {
      const c = inspect(model)[Number(el.dataset.code)];
      if (!c) return;
      selection = {
        anchor: { block: c.blockIndex, offset: c.start },
        focus: { block: c.blockIndex, offset: c.end },
      };
      writeSelection();
      editor.focus();
      updateExplain();
    });
  });
}

function updateToolbar(): void {
  const collapsed = isCollapsed(selection);
  (["bold", "italic", "underline", "strike"] as Mark[]).forEach((m) => {
    const btn = document.getElementById(`btn-${m}`);
    if (!btn) return;
    const active = collapsed
      ? (caretMarks ?? marksAt(model.blocks[selection.focus.block]!, selection.focus.offset)).includes(m)
      : rangeHasMark(model, selection, m);
    btn.classList.toggle("active", active);
  });
  const blockSel = document.getElementById("block-type") as HTMLSelectElement | null;
  if (blockSel) blockSel.value = model.blocks[selection.focus.block]?.type ?? "paragraph";
}

function updateExplain(): void {
  explainEl.textContent = explainAt(model, selection.focus.block, selection.focus.offset);
}

// ---------- command dispatch (§18.2) ----------
type CommandId =
  | "findReplaceOne"
  | "findReplaceAll"
  | "indentList"
  | "outdentList"
  | "insertTable"
  | "insertText"
  | "deleteBackward"
  | "deleteSelection"
  | "splitBlock"
  | "toggleMark"
  | "setBlockType"
  | "undo"
  | "redo";

function dispatch(id: CommandId, payload?: unknown): void {
  if (id === "undo" || id === "redo") {
    const journaled: PrimOp[] = [];
    const rec = { record: (op: PrimOp) => void journaled.push(op) };
    const ok = id === "undo" ? log.undo(model, rec) : log.redo(model, rec);
    if (ok) {
      if (journaled.length > 0) {
        try {
          journal?.append(actorId, journaled, `${id}-${Date.now().toString(36)}`);
        } catch (err) {
          console.error("journal append failed:", err);
        }
      }
      selection = {
        anchor: clampPosition(model, selection.anchor),
        focus: clampPosition(model, selection.focus),
      };
      caretMarks = null;
      render();
      scheduleSave();
    }
    return;
  }

  const coalesceKey = id === "insertText" ? "type" : id === "deleteBackward" ? "del" : null;
  log.begin(coalesceKey);

  switch (id) {
    case "insertText": {
      const text = String(payload ?? "");
      if (!isCollapsed(selection)) {
        const caret = deleteRange(model, selection, log);
        selection = { anchor: caret, focus: caret };
      }
      const marks =
        caretMarks ?? marksAt(model.blocks[selection.focus.block]!, selection.focus.offset);
      const caret = insertText(model, selection.focus, text, marks, log);
      selection = { anchor: caret, focus: caret };
      break;
    }
    case "deleteSelection": {
      const caret = deleteRange(model, selection, log);
      selection = { anchor: caret, focus: caret };
      break;
    }
    case "deleteBackward": {
      if (!isCollapsed(selection)) {
        const caret = deleteRange(model, selection, log);
        selection = { anchor: caret, focus: caret };
      } else if (selection.focus.offset > 0) {
        const caret = deleteRange(model, {
          anchor: { block: selection.focus.block, offset: selection.focus.offset - 1 },
          focus: selection.focus,
        }, log);
        selection = { anchor: caret, focus: caret };
      } else if (selection.focus.block > 0) {
        const caret = mergeWithPrevious(model, selection.focus.block, log);
        selection = { anchor: caret, focus: caret };
      }
      break;
    }
    case "splitBlock": {
      if (!isCollapsed(selection)) {
        const caret = deleteRange(model, selection, log);
        selection = { anchor: caret, focus: caret };
      }
      const cur = model.blocks[selection.focus.block];
      if (
        cur &&
        (cur.type === "bullet" || cur.type === "numbered") &&
        blockText(cur).length === 0
      ) {
        // Enter on an empty list item exits the list
        setBlockType(model, selection, "paragraph", log);
        break;
      }
      const caret = splitBlock(model, selection.focus, log);
      selection = { anchor: caret, focus: caret };
      break;
    }
    case "toggleMark": {
      const mark = payload as Mark;
      if (isCollapsed(selection)) {
        const base =
          caretMarks ?? marksAt(model.blocks[selection.focus.block]!, selection.focus.offset);
        caretMarks = base.includes(mark) ? base.filter((m) => m !== mark) : [...base, mark];
        updateToolbar();
        return; // no model change yet; next typed character applies it
      }
      toggleMark(model, selection, mark, log);
      break;
    }
    case "indentList":
      setListIndent(model, selection, 1, log);
      break;
    case "outdentList":
      setListIndent(model, selection, -1, log);
      break;
    case "insertTable": {
      const cur = model.blocks[selection.focus.block];
      if (cur?.type === "table") break; // no tables inside tables in v0
      const caret = insertTable(model, selection.focus, 3, 3, log);
      selection = { anchor: caret, focus: caret };
      activeTableBlock = caret.block - 1;
      break;
    }
    case "setBlockType": {
      setBlockType(model, selection, payload as Block["type"], log);
      break;
    }
    case "findReplaceOne": {
      const { match, replacement } = payload as { match: TextMatch; replacement: string };
      const caret = replaceMatch(model, match, replacement, log);
      selection = { anchor: { block: match.block, offset: match.from }, focus: caret };
      break;
    }
    case "findReplaceAll": {
      const { query, replacement, matchCase } = payload as {
        query: string;
        replacement: string;
        matchCase: boolean;
      };
      const n = replaceAll(model, query, replacement, matchCase, log);
      selection = {
        anchor: clampPosition(model, selection.anchor),
        focus: clampPosition(model, selection.focus),
      };
      statusEl.textContent = n > 0 ? `Replaced ${n} occurrence${n === 1 ? "" : "s"}` : "No matches";
      break;
    }
  }
  if (id !== "toggleMark") caretMarks = null;
  render();
  scheduleSave();
}

// ---------- input wiring ----------
editor.addEventListener("beforeinput", (e: InputEvent) => {
  e.preventDefault();
  readSelection();
  switch (e.inputType) {
    case "insertText":
      if (e.data) dispatch("insertText", e.data);
      break;
    case "insertParagraph":
      dispatch("splitBlock");
      break;
    case "deleteContentBackward":
      dispatch("deleteBackward");
      break;
    case "deleteContentForward": {
      const { focus } = selection;
      if (!isCollapsed(selection)) dispatch("deleteSelection");
      else {
        const len = blockText(model.blocks[focus.block]!).length;
        if (focus.offset < len) {
          selection = { anchor: focus, focus: { block: focus.block, offset: focus.offset + 1 } };
          dispatch("deleteSelection");
        } else if (focus.block < model.blocks.length - 1) {
          selection = { anchor: focus, focus: { block: focus.block + 1, offset: 0 } };
          dispatch("deleteSelection");
        }
      }
      break;
    }
    case "insertFromPaste": {
      const text = e.dataTransfer?.getData("text/plain") ?? "";
      if (text) {
        const parts = text.split(/\r?\n/);
        parts.forEach((part, i) => {
          if (i > 0) dispatch("splitBlock");
          if (part) dispatch("insertText", part);
        });
      }
      break;
    }
    case "formatBold":
      dispatch("toggleMark", "bold");
      break;
    case "formatItalic":
      dispatch("toggleMark", "italic");
      break;
    case "formatUnderline":
      dispatch("toggleMark", "underline");
      break;
    default:
      break; // unsupported input types are ignored, never half-applied
  }
});

editor.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Tab") {
    readSelection();
    const cur = model.blocks[selection.focus.block];
    if (cur && (cur.type === "bullet" || cur.type === "numbered")) {
      e.preventDefault();
      dispatch(e.shiftKey ? "outdentList" : "indentList");
      return;
    }
  }
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); dispatch("undo"); }
  else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); dispatch("redo"); }
  else if (k === "b") { e.preventDefault(); readSelection(); dispatch("toggleMark", "bold"); }
  else if (k === "i") { e.preventDefault(); readSelection(); dispatch("toggleMark", "italic"); }
  else if (k === "u") { e.preventDefault(); readSelection(); dispatch("toggleMark", "underline"); }
  else if (k === "f") { e.preventDefault(); openFindBar(); }
});

document.addEventListener("selectionchange", () => {
  if (document.activeElement === editor || editor.contains(window.getSelection()?.anchorNode ?? null)) {
    readSelection();
  }
});

// ---------- toolbar ----------
(["bold", "italic", "underline", "strike"] as Mark[]).forEach((m) => {
  document.getElementById(`btn-${m}`)?.addEventListener("mousedown", (e) => {
    e.preventDefault(); // keep editor selection
    readSelection();
    dispatch("toggleMark", m);
  });
});
document.getElementById("btn-table")?.addEventListener("click", () => dispatch("insertTable"));
document.getElementById("block-type")?.addEventListener("change", (e) => {
  dispatch("setBlockType", (e.target as HTMLSelectElement).value);
  editor.focus();
});
document.getElementById("btn-undo")?.addEventListener("click", () => dispatch("undo"));
document.getElementById("btn-redo")?.addEventListener("click", () => dispatch("redo"));

// ---------- export ----------
// In the artifact sandbox, anchor downloads are blocked; the host mediates
// saves through the `downloads` capability. Fall back to an anchor when the
// page runs as a plain local file.
declare global {
  interface Window {
    claude?: { use: (name: string) => Promise<{ save: (o: { filename: string; data: Blob | string }) => Promise<unknown> } | null> };
  }
}
let hostDownloads: { save: (o: { filename: string; data: Blob | string }) => Promise<unknown> } | null = null;
if (window.claude?.use) {
  window.claude.use("downloads").then((d) => { hostDownloads = d; }).catch(() => {});
}

async function downloadBlob(name: string, blob: Blob): Promise<void> {
  if (hostDownloads) {
    try {
      await hostDownloads.save({ filename: name, data: blob });
      return;
    } catch {
      /* viewer declined or save failed; fall through to anchor attempt */
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function download(name: string, mime: string, content: string): Promise<void> {
  return downloadBlob(name, new Blob([content], { type: mime }));
}

function downloadBytes(name: string, mime: string, bytes: Uint8Array): Promise<void> {
  return downloadBlob(name, new Blob([bytes as BlobPart], { type: mime }));
}

document.getElementById("btn-export-md")?.addEventListener("click", () => {
  const { markdown, report } = toMarkdown(model);
  if (!report.lossless) {
    const msgs = [...new Set(report.warnings.map((w) => w.message))].join("\n• ");
    const ok = window.confirm(
      `Markdown export is not lossless for this document:\n\n• ${msgs}\n\nExport anyway?`
    );
    if (!ok) return;
  }
  download("document.md", "text/markdown", markdown);
});
document.getElementById("btn-export-html")?.addEventListener("click", () => {
  download(
    "document.html",
    "text/html",
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Casserole Write export</title></head><body>\n${toHTML(model)}\n</body></html>`
  );
});
document.getElementById("btn-export-json")?.addEventListener("click", () => {
  download("document.json", "application/json", toJSON(model));
});
document.getElementById("btn-export-docx")?.addEventListener("click", async () => {
  try {
    const { bytes, report } = await exportDocx(model, { preserved: preservedDocx });
    if (!report.lossless) {
      const msgs = [...new Set(report.warnings.map((w) => w.message))].join("\n• ");
      if (!window.confirm(`DOCX export is not lossless:\n\n• ${msgs}\n\nExport anyway?`)) return;
    }
    await downloadBytes(`${currentTitle || "document"}.docx`,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes);
  } catch (err) {
    statusEl.textContent = `⚠ DOCX export failed: ${err instanceof Error ? err.message : String(err)}`;
  }
});
document.getElementById("btn-export-pdf")?.addEventListener("click", async () => {
  try {
    const { bytes, report } = exportPdf(model);
    const real = report.warnings.filter((w) => w.code !== "PDF-FONT-FAMILY");
    if (real.length > 0) {
      const msgs = [...new Set(real.map((w) => w.message))].join("\n• ");
      if (!window.confirm(`PDF export notes:\n\n• ${msgs}\n\nExport anyway?`)) return;
    }
    await downloadBytes(`${currentTitle || "document"}.pdf`, "application/pdf", bytes);
  } catch (err) {
    statusEl.textContent = `⚠ PDF export failed: ${err instanceof Error ? err.message : String(err)}`;
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
    if (file.name.toLowerCase().endsWith(".json")) {
      const imported = fromJSON(await file.text());
      await createDoc(imported, file.name.replace(/\.json$/i, ""));
      statusEl.textContent = "Imported JSON document";
      return;
    }
    const { model: imported, report } = await importDocx(new Uint8Array(await file.arrayBuffer()));
    await createDoc(imported, file.name.replace(/\.docx$/i, ""));
    if (report.lossless) {
      statusEl.textContent = "Imported DOCX — no loss detected for this document";
    } else {
      const byCode = new Map<string, number>();
      report.warnings.forEach((w) => byCode.set(w.code, (byCode.get(w.code) ?? 0) + 1));
      const summary = [...byCode.entries()].map(([c, n]) => `${c} ×${n}`).join(", ");
      statusEl.textContent = `Imported DOCX with losses: ${summary}`;
      window.alert(
        `Import loss report:\n\n` +
          [...new Set(report.warnings.map((w) => `• ${w.message}`))].join("\n")
      );
    }
  } catch (err) {
    statusEl.textContent = `⚠ Import failed: ${err instanceof Error ? err.message : String(err)}`;
  }
});
// ---------- files surface (multi-document) ----------
async function refreshDocList(): Promise<void> {
  if (!store || !docListEl) return;
  const metas = await store.list();
  docListEl.innerHTML = metas
    .map(
      (m) =>
        `<option value="${m.id}"${m.id === currentDocId ? " selected" : ""}>${m.title
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")}</option>`
    )
    .join("");
}

function resetEditorState(
  newModel: DocModel,
  title: string,
  id: string,
  revs: StoredRevision[] = [],
  journalJson?: string,
  preserved: PreservedPart[] = []
): void {
  log.clear();
  preservedDocx = preserved;
  model = newModel;
  journal = null;
  if (journalJson) {
    try {
      const restored = DocumentJournal.fromJSON(journalJson);
      // trust, then verify: the journal must replay to exactly this document
      if (snapModel(restored.replay()) === snapModel(newModel)) {
        journal = restored;
      } else {
        console.warn("journal replay mismatch; starting a fresh journal from the current state");
      }
    } catch (err) {
      console.warn("stored journal unreadable; starting fresh:", err);
    }
  }
  if (!journal) journal = new DocumentJournal(fromJSON(toJSON(newModel)));
  currentDocId = id;
  currentTitle = title;
  revisions = revs;
  if (titleEl) titleEl.value = title;
  selection = { anchor: { block: 0, offset: 0 }, focus: { block: 0, offset: 0 } };
  caretMarks = null;
  render();
}

async function openDoc(id: string): Promise<void> {
  if (!store) return;
  if (dirtySinceSave) await save();
  const stored = await store.load(id);
  if (!stored) {
    statusEl.textContent = "Document not found";
    return;
  }
  try {
    resetEditorState(
      fromJSON(JSON.stringify(stored.doc)),
      stored.title,
      stored.id,
      stored.revisions ?? [],
      stored.journal,
      (stored.preservedDocx ?? []).map((p) => ({ name: p.name, data: bytesFromB64(p.b64) }))
    );
    statusEl.textContent = `Opened — last saved ${new Date(stored.updatedAt).toLocaleString()}`;
  } catch {
    statusEl.textContent = "⚠ Stored document could not be read (left untouched)";
  }
  await refreshDocList();
}

async function createDoc(seed?: DocModel, title = "Untitled document"): Promise<void> {
  if (!store) return;
  if (dirtySinceSave) await save();
  resetEditorState(seed ?? newDocument(), title, newDocId());
  await save();
}

docListEl?.addEventListener("change", () => void openDoc(docListEl.value));
titleEl?.addEventListener("change", () => scheduleSave());
document.getElementById("btn-new")?.addEventListener("click", () => void createDoc());
document.getElementById("btn-delete")?.addEventListener("click", async () => {
  if (!store) return;
  if (!window.confirm(`Delete "${currentTitle}"? This cannot be undone.`)) return;
  await store.remove(currentDocId);
  const metas = await store.list();
  if (metas.length > 0) await openDoc(metas[0]!.id);
  else await createDoc();
});

function seedModel(): DocModel {
  // Seed content so the inspector has something to show on first run.
  return fromJSON(
    JSON.stringify({
      schemaVersion: "1.0",
      blocks: [
        { id: "seed1", type: "heading1", runs: [{ text: "Casserole Write", marks: [] }] },
        {
          id: "seed2",
          type: "paragraph",
          runs: [
            { text: "This is a ", marks: [] },
            { text: "working", marks: ["bold"] },
            { text: " vertical slice: a typed document model, command-dispatched editing, ", marks: [] },
            { text: "undo/redo", marks: ["italic"] },
            { text: ", durable autosave with crash recovery, multiple documents, and a Reveal Codes panel on the right. Try Ctrl/Cmd-B, Enter, and the export buttons.", marks: [] },
          ],
        },
      ],
    })
  );
}

// ---------- revisions (§14.2 middle layer) ----------
const revPanel = document.getElementById("revisions") as HTMLElement | null;
const revList = document.getElementById("rev-list") as HTMLElement | null;

function escapeHtmlText(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function summarizeOps(ops: PrimOp[]): string {
  let ins = 0;
  let del = 0;
  let splits = 0;
  let merges = 0;
  let retypes = 0;
  let snapshots = 0;
  for (const op of ops) {
    if (op.t === "replace-runs") {
      ins += op.after.reduce((n, r) => n + r.text.length, 0);
      del += op.before.reduce((n, r) => n + r.text.length, 0);
    } else if (op.t === "split-block") splits++;
    else if (op.t === "merge-blocks") merges++;
    else if (op.t === "set-block-type") retypes++;
    else if (op.t === "replace-model") snapshots++;
  }
  const parts: string[] = [];
  if (ins) parts.push(`+${ins}`);
  if (del) parts.push(`−${del}`);
  if (splits) parts.push(`${splits}¶`);
  if (merges) parts.push(`${merges} merge`);
  if (retypes) parts.push(`${retypes} retype`);
  if (snapshots) parts.push("snapshot restore");
  return parts.join(" ") || "no-op";
}

function activityHtml(): string {
  if (!journal || journal.size() === 0) return "";
  const recent: OpTransaction[] = journal.list().slice(-8).reverse();
  const rows = recent
    .map(
      (t) =>
        `<div class="act-row"><span class="act-actor">${escapeHtmlText(t.actorId)}</span>` +
        `<span class="act-sum">${escapeHtmlText(summarizeOps(t.ops))}</span>` +
        `<span class="act-time">${new Date(t.at).toLocaleTimeString()}</span></div>`
    )
    .join("");
  return (
    `<div class="act-head">Recent activity — ${journal.size()} transaction(s), ` +
    `${journal.actors().map(escapeHtmlText).join(", ")}</div>` + rows
  );
}

function renderRevisions(): void {
  if (!revList) return;
  if (revisions.length === 0) {
    revList.innerHTML =
      `<div class="rev-empty">No revisions yet. "Save revision" captures a named, restorable state of this document.</div>` +
      activityHtml();
    return;
  }
  revList.innerHTML = activityHtml() + [...revisions]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map(
      (r) =>
        `<div class="rev-item" data-rev="${r.id}">` +
        `<div class="rev-head"><span class="rev-name">${escapeHtmlText(r.name)}</span>` +
        `<span class="rev-time">${new Date(r.at).toLocaleString()}</span></div>` +
        `<div class="rev-actions">` +
        `<button data-compare="${r.id}">Compare</button>` +
        `<button data-restore="${r.id}">Restore</button>` +
        `<button data-revdel="${r.id}">Delete</button>` +
        `</div><div class="rev-diff" data-diff="${r.id}"></div></div>`
    )
    .join("");
  revList.querySelectorAll<HTMLButtonElement>("[data-compare]").forEach((btn) =>
    btn.addEventListener("click", () => compareRevision(btn.dataset.compare!))
  );
  revList.querySelectorAll<HTMLButtonElement>("[data-restore]").forEach((btn) =>
    btn.addEventListener("click", () => restoreRevision(btn.dataset.restore!))
  );
  revList.querySelectorAll<HTMLButtonElement>("[data-revdel]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const rev = revisions.find((r) => r.id === btn.dataset.revdel);
      if (!rev || !window.confirm(`Delete revision "${rev.name}"?`)) return;
      revisions = revisions.filter((r) => r.id !== rev.id);
      renderRevisions();
      scheduleSave();
    })
  );
}

function compareRevision(revId: string): void {
  const rev = revisions.find((r) => r.id === revId);
  const target = revList?.querySelector(`[data-diff="${revId}"]`) as HTMLElement | null;
  if (!rev || !target) return;
  if (target.innerHTML !== "") {
    target.innerHTML = ""; // toggle off
    return;
  }
  try {
    const revModel = fromJSON(JSON.stringify(rev.doc));
    const entries = diffModels(revModel, model);
    const s = diffSummary(entries);
    const lines = entries
      .filter((e) => e.kind !== "unchanged")
      .map((e) => {
        if (e.kind === "added") {
          return `<div class="d-add">+ ${escapeHtmlText(blockText(model.blocks[e.b!]!) || "(empty block)")}</div>`;
        }
        if (e.kind === "removed") {
          return `<div class="d-del">− ${escapeHtmlText(blockText(revModel.blocks[e.a!]!) || "(empty block)")}</div>`;
        }
        if (!e.textChanged) {
          return (
            `<div class="d-chg">~ (formatting only) ` +
            `${escapeHtmlText(blockText(model.blocks[e.b!]!))}</div>`
          );
        }
        // word-level inline diff for text changes
        const segs = diffBlockText(blockText(revModel.blocks[e.a!]!), blockText(model.blocks[e.b!]!));
        const inline = segs
          .map((seg) => {
            const t = escapeHtmlText(seg.text);
            if (seg.kind === "del") return `<span class="d-old">${t}</span>`;
            if (seg.kind === "ins") return `<span class="d-new">${t}</span>`;
            return t;
          })
          .join("");
        return `<div class="d-chg">~ ${inline}</div>`;
      });
    target.innerHTML =
      `<div class="d-sum">${s.changed} changed · ${s.added} added · ${s.removed} removed · ${s.unchanged} unchanged</div>` +
      (lines.join("") || `<div class="d-sum">Identical to the current document.</div>`);
  } catch {
    target.innerHTML = `<div class="d-sum">⚠ Revision could not be read.</div>`;
  }
}

function restoreRevision(revId: string): void {
  const rev = revisions.find((r) => r.id === revId);
  if (!rev) return;
  if (!window.confirm(`Restore revision "${rev.name}"? The current state stays in undo history.`)) return;
  try {
    const revModel = fromJSON(JSON.stringify(rev.doc));
    log.begin();
    const op = {
      t: "replace-model",
      before: fromJSON(toJSON(model)),
      after: revModel,
    } as const;
    log.record(op);
    applyOp(model, op);
    selection = { anchor: { block: 0, offset: 0 }, focus: { block: 0, offset: 0 } };
    caretMarks = null;
    render();
    scheduleSave();
    statusEl.textContent = `Restored revision "${rev.name}"`;
    renderRevisions();
  } catch {
    statusEl.textContent = "⚠ Revision could not be restored (left untouched)";
  }
}

document.getElementById("btn-revisions")?.addEventListener("click", () => {
  if (!revPanel) return;
  revPanel.hidden = !revPanel.hidden;
  if (!revPanel.hidden) renderRevisions();
});
document.getElementById("btn-rev-save")?.addEventListener("click", () => {
  const name = window.prompt("Name this revision:", `Revision ${revisions.length + 1}`);
  if (name === null) return;
  revisions.push({
    id: newDocId(),
    name: name.trim() || `Revision ${revisions.length + 1}`,
    at: new Date().toISOString(),
    doc: JSON.parse(toJSON(model)),
  });
  renderRevisions();
  scheduleSave();
  statusEl.textContent = "Revision saved";
});
document.getElementById("btn-rev-close")?.addEventListener("click", () => {
  if (revPanel) revPanel.hidden = true;
});

// ---------- tables: cell editing + structure controls ----------
let cellInput: HTMLInputElement | null = null;

function closeCellInput(commit: boolean): void {
  if (!cellInput) return;
  const input = cellInput;
  cellInput = null;
  const bi = Number(input.dataset.bi);
  const r = Number(input.dataset.r);
  const c = Number(input.dataset.c);
  const value = input.value;
  input.remove();
  if (commit) {
    const table = model.blocks[bi]?.table;
    if (table && table[r]?.[c] !== undefined && table[r]![c] !== value) {
      log.begin();
      setTableCell(model, bi, r, c, value, log);
      scheduleSave();
    }
  }
  render();
}

function openCellInput(bi: number, r: number, c: number, td: HTMLElement): void {
  closeCellInput(true);
  const rect = td.getBoundingClientRect();
  const host = editor.getBoundingClientRect();
  const input = document.createElement("input");
  input.className = "cell-input";
  input.value = model.blocks[bi]?.table?.[r]?.[c] ?? "";
  input.dataset.bi = String(bi);
  input.dataset.r = String(r);
  input.dataset.c = String(c);
  input.style.left = `${rect.left - host.left}px`;
  input.style.top = `${rect.top - host.top}px`;
  input.style.width = `${Math.max(60, rect.width)}px`;
  input.style.height = `${rect.height}px`;
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") closeCellInput(false);
    else if (e.key === "Enter") closeCellInput(true);
    else if (e.key === "Tab") {
      e.preventDefault();
      const table = model.blocks[bi]?.table;
      closeCellInput(true);
      if (table) {
        const nc = c + 1 < table[0]!.length ? c + 1 : 0;
        const nr = nc === 0 ? (r + 1) % table.length : r;
        const next = editor.querySelector(
          `[data-block="${bi}"] [data-r="${nr}"][data-c="${nc}"]`
        ) as HTMLElement | null;
        if (next) openCellInput(bi, nr, nc, next);
      }
    }
  });
  input.addEventListener("blur", () => closeCellInput(true));
  editor.style.position = "relative";
  editor.appendChild(input);
  cellInput = input;
  input.focus();
  input.select();
}

editor.addEventListener("click", (e) => {
  const td = (e.target as HTMLElement).closest("td[data-r], th[data-r]") as HTMLElement | null;
  const wrap = (e.target as HTMLElement).closest(".tbl-wrap") as HTMLElement | null;
  const btn = (e.target as HTMLElement).closest("[data-tedit]") as HTMLButtonElement | null;
  if (btn && wrap) {
    const bi = Number(wrap.dataset.block);
    const action = btn.dataset.tedit!;
    if (action === "delete") {
      if (!window.confirm("Delete this table and its contents?")) return;
      log.begin();
      removeTable(model, bi, log);
      activeTableBlock = null;
    } else if (action === "header") {
      log.begin();
      setTableStyle(model, bi, { headerRow: !(model.blocks[bi]?.tableStyle?.headerRow ?? false) }, log);
    } else if (action === "align" || action === "wider" || action === "narrower") {
      const blk = model.blocks[bi];
      if (!blk?.table) return;
      const cols = blk.table[0]!.length;
      const c = Math.min(activeTableCol, cols - 1);
      log.begin();
      if (action === "align") {
        const cycle: ("left" | "center" | "right" | null)[] = [null, "center", "right", "left"];
        const cur = blk.tableStyle?.aligns?.[c] ?? null;
        const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length]!;
        const aligns = (blk.tableStyle?.aligns ?? new Array(cols).fill(null)).slice();
        aligns[c] = next;
        setTableStyle(model, bi, { aligns }, log);
        statusEl.textContent = `Column ${c + 1} aligned ${next ?? "default"}`;
      } else {
        const widths = (blk.tableStyle?.widths ?? new Array<number>(cols).fill(1)).slice();
        widths[c] = Math.max(0.3, Math.min(5, widths[c]! * (action === "wider" ? 1.25 : 0.8)));
        setTableStyle(model, bi, { widths }, log);
      }
    } else {
      log.begin();
      editTable(model, bi, action as TableEdit, log);
    }
    render();
    scheduleSave();
    return;
  }
  if (td && wrap) {
    const bi = Number(wrap.dataset.block);
    activeTableCol = Number(td.dataset.c ?? 0);
    if (activeTableBlock !== bi) {
      activeTableBlock = bi;
      render();
      const again = editor.querySelector(
        `[data-block="${bi}"] [data-r="${td.dataset.r}"][data-c="${td.dataset.c}"]`
      ) as HTMLElement | null;
      if (again) openCellInput(bi, Number(td.dataset.r), Number(td.dataset.c), again);
      return;
    }
    openCellInput(bi, Number(td.dataset.r), Number(td.dataset.c), td);
    return;
  }
  if (activeTableBlock !== null && !wrap) {
    activeTableBlock = null;
    render();
  }
});

// ---------- command registry + palette (§18.2) ----------
// One canonical implementation per command: editing commands run through
// dispatch; file/export commands run through their single wired control, so
// ribbon and palette share one code path (full inversion is the next step —
// see ADR-0003 consequences).
const clickCmd = (id: string) => () =>
  (document.getElementById(id) as HTMLButtonElement | null)?.click();

function markCmd(mark: Mark, name: string, shortcut: string): CommandDefinition {
  return {
    id: `format.${mark}`,
    name,
    description: `Toggle ${name.toLowerCase()} on the selection`,
    isPermitted: () => true,
    isAvailable: () => true,
    undoable: true,
    shortcut,
    auditClassification: "document-modification",
    run: () => dispatch("toggleMark", mark),
  };
}

function blockCmd(type: Block["type"], name: string): CommandDefinition {
  return {
    id: `block.${type}`,
    name,
    description: `Make the selected block(s) ${name.toLowerCase()}`,
    isPermitted: () => true,
    isAvailable: () => true,
    undoable: true,
    auditClassification: "document-modification",
    run: () => dispatch("setBlockType", type),
  };
}

const COMMANDS: CommandDefinition[] = [
  {
    id: "edit.find",
    name: "Find & replace",
    description: "Search the document and replace matches",
    isPermitted: () => true,
    isAvailable: () => true,
    undoable: false,
    shortcut: "Ctrl/Cmd-F",
    auditClassification: "read",
    run: () => openFindBar(),
  },
  markCmd("bold", "Bold", "Ctrl/Cmd-B"),
  markCmd("italic", "Italic", "Ctrl/Cmd-I"),
  markCmd("underline", "Underline", "Ctrl/Cmd-U"),
  blockCmd("paragraph", "Paragraph"),
  blockCmd("heading1", "Heading 1"),
  blockCmd("heading2", "Heading 2"),
  blockCmd("bullet", "Bulleted list"),
  blockCmd("numbered", "Numbered list"),
  {
    id: "list.indent", name: "Increase list indent", description: "Nest the list item one level deeper (Tab)",
    isPermitted: () => true,
    isAvailable: () => ["bullet", "numbered"].includes(model.blocks[selection.focus.block]?.type ?? ""),
    undoable: true, shortcut: "Tab", auditClassification: "document-modification",
    run: () => dispatch("indentList"),
  },
  {
    id: "list.outdent", name: "Decrease list indent", description: "Un-nest the list item (Shift-Tab)",
    isPermitted: () => true,
    isAvailable: () => ["bullet", "numbered"].includes(model.blocks[selection.focus.block]?.type ?? ""),
    undoable: true, shortcut: "Shift-Tab", auditClassification: "document-modification",
    run: () => dispatch("outdentList"),
  },
  {
    id: "edit.undo", name: "Undo", description: "Undo the last transaction",
    isPermitted: () => true, isAvailable: () => log.canUndo(), undoable: false,
    shortcut: "Ctrl/Cmd-Z", auditClassification: "document-modification",
    run: () => dispatch("undo"),
  },
  {
    id: "edit.redo", name: "Redo", description: "Redo the last undone transaction",
    isPermitted: () => true, isAvailable: () => log.canRedo(), undoable: false,
    shortcut: "Ctrl/Cmd-Y", auditClassification: "document-modification",
    run: () => dispatch("redo"),
  },
  {
    id: "insert.table", name: "Insert table", description: "Insert a 3\u00d73 table after the caret",
    isPermitted: () => true, isAvailable: () => model.blocks[selection.focus.block]?.type !== "table",
    undoable: true, auditClassification: "document-modification",
    run: () => dispatch("insertTable"),
  },
  {
    id: "files.new", name: "New document", description: "Create a new document",
    isPermitted: () => true, isAvailable: () => store !== null, undoable: false,
    auditClassification: "document-modification", run: clickCmd("btn-new"),
  },
  {
    id: "files.delete", name: "Delete document", description: "Delete the current document (confirms first)",
    isPermitted: () => true, isAvailable: () => store !== null, undoable: false,
    auditClassification: "document-modification", run: clickCmd("btn-delete"),
  },
  {
    id: "files.open", name: "Open file (.docx / .json)", description: "Import a Word or native JSON document",
    isPermitted: () => true, isAvailable: () => true, undoable: false,
    auditClassification: "document-modification", run: clickCmd("btn-open"),
  },
  {
    id: "export.docx", name: "Export DOCX", description: "Download as a Word document",
    isPermitted: () => true, isAvailable: () => true, undoable: false,
    auditClassification: "export", run: clickCmd("btn-export-docx"),
  },
  {
    id: "export.pdf", name: "Export PDF", description: "Download as a paginated PDF",
    isPermitted: () => true, isAvailable: () => true, undoable: false,
    auditClassification: "export", run: clickCmd("btn-export-pdf"),
  },
  {
    id: "export.markdown", name: "Export Markdown", description: "Download as Markdown (loss report shown if lossy)",
    isPermitted: () => true, isAvailable: () => true, undoable: false,
    auditClassification: "export", run: clickCmd("btn-export-md"),
  },
  {
    id: "export.html", name: "Export HTML", description: "Download as HTML",
    isPermitted: () => true, isAvailable: () => true, undoable: false,
    auditClassification: "export", run: clickCmd("btn-export-html"),
  },
  {
    id: "export.json", name: "Export JSON", description: "Download the native document model",
    isPermitted: () => true, isAvailable: () => true, undoable: false,
    auditClassification: "export", run: clickCmd("btn-export-json"),
  },
];

const paletteEl = document.getElementById("palette") as HTMLElement | null;
const palInput = document.getElementById("pal-input") as HTMLInputElement | null;
const palList = document.getElementById("pal-list") as HTMLElement | null;
let palIndex = 0;

function paletteMatches(): CommandDefinition[] {
  const q = (palInput?.value ?? "").trim().toLowerCase();
  return COMMANDS.filter(
    (c) =>
      c.isPermitted(null) &&
      c.isAvailable(null) &&
      (q === "" || c.name.toLowerCase().includes(q) || c.id.includes(q))
  );
}

function renderPalette(): void {
  if (!palList) return;
  const matches = paletteMatches();
  palIndex = Math.max(0, Math.min(palIndex, matches.length - 1));
  palList.innerHTML = matches
    .map(
      (c, i) =>
        `<div class="pal-item${i === palIndex ? " active" : ""}" data-i="${i}">` +
        `<span class="pal-name">${c.name}</span>` +
        `<span class="pal-desc">${c.description}</span>` +
        (c.shortcut ? `<span class="pal-key">${c.shortcut}</span>` : "") +
        `</div>`
    )
    .join("") || `<div class="pal-empty">No matching commands</div>`;
  palList.querySelectorAll<HTMLElement>(".pal-item").forEach((item) => {
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      runPaletteCommand(Number(item.dataset.i));
    });
  });
}

function openPalette(): void {
  if (!paletteEl || !palInput) return;
  readSelection();
  paletteEl.hidden = false;
  palInput.value = "";
  palIndex = 0;
  renderPalette();
  palInput.focus();
}

function closePalette(): void {
  if (!paletteEl) return;
  paletteEl.hidden = true;
  editor.focus();
  writeSelection();
}

function runPaletteCommand(index: number): void {
  const cmd = paletteMatches()[index];
  closePalette();
  if (cmd) {
    cmd.run(null, undefined);
    statusEl.textContent = `Ran: ${cmd.name}`;
  }
}

palInput?.addEventListener("input", () => {
  palIndex = 0;
  renderPalette();
});
palInput?.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Escape") closePalette();
  else if (e.key === "ArrowDown") { palIndex++; renderPalette(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { palIndex--; renderPalette(); e.preventDefault(); }
  else if (e.key === "Enter") { e.preventDefault(); runPaletteCommand(palIndex); }
});
paletteEl?.addEventListener("mousedown", (e) => {
  if (e.target === paletteEl) closePalette();
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (paletteEl?.hidden) openPalette();
    else closePalette();
  }
});

// ---------- boot ----------
async function boot(): Promise<void> {
  render(); // paint immediately; storage attaches when ready
  try {
    store = await openBestStore();
  } catch {
    store = null;
  }
  if (!store) {
    statusEl.textContent = "⚠ No storage available — export to keep your work";
    return;
  }
  const metas = await store.list();
  if (metas.length > 0) {
    await openDoc(metas[0]!.id);
  } else {
    await createDoc(seedModel(), "Welcome to Casserole Write");
  }
  if (store.durability !== "durable") {
    statusEl.textContent = `Storage degraded: ${store.kind}${durabilityNote()}`;
  }
}

void boot();
editor.focus();

// ---------- find & replace bar (WO-37) ----------
const findbarEl = document.getElementById("findbar") as HTMLElement;
const findQ = document.getElementById("find-q") as HTMLInputElement;
const findR = document.getElementById("find-r") as HTMLInputElement;
const findCase = document.getElementById("find-case") as HTMLInputElement;
const findCountEl = document.getElementById("find-count") as HTMLElement;
let findIdx = -1;

function currentMatches(): TextMatch[] {
  return findMatches(model, findQ.value, findCase.checked);
}

function updateFindCount(ms: TextMatch[]): void {
  findCountEl.textContent =
    findQ.value.length === 0 ? "" : ms.length === 0 ? "No matches" : `${findIdx + 1 > 0 ? findIdx + 1 : "–"} / ${ms.length}`;
}

function openFindBar(): void {
  findbarEl.hidden = false;
  findIdx = -1;
  findQ.focus();
  findQ.select();
  updateFindCount(currentMatches());
}

function closeFindBar(): void {
  findbarEl.hidden = true;
  editor.focus();
}

function selectMatch(m: TextMatch): void {
  selection = { anchor: { block: m.block, offset: m.from }, focus: { block: m.block, offset: m.to } };
  render();
  const node = window.getSelection()?.focusNode;
  (node instanceof Element ? node : node?.parentElement)?.scrollIntoView({ block: "nearest" });
}

function findNext(): void {
  const ms = currentMatches();
  if (ms.length === 0) {
    findIdx = -1;
    updateFindCount(ms);
    return;
  }
  findIdx = (findIdx + 1) % ms.length;
  selectMatch(ms[findIdx]!);
  updateFindCount(ms);
}

function replaceCurrent(): void {
  const ms = currentMatches();
  if (ms.length === 0) {
    updateFindCount(ms);
    return;
  }
  const idx = findIdx >= 0 && findIdx < ms.length ? findIdx : 0;
  dispatch("findReplaceOne", { match: ms[idx]!, replacement: findR.value });
  findIdx = idx - 1; // next findNext lands on the match after the replacement
  findNext();
}

function replaceAllFromBar(): void {
  if (findQ.value.length === 0) return;
  dispatch("findReplaceAll", { query: findQ.value, replacement: findR.value, matchCase: findCase.checked });
  findIdx = -1;
  updateFindCount(currentMatches());
}

findQ.addEventListener("input", () => {
  findIdx = -1;
  updateFindCount(currentMatches());
});
findCase.addEventListener("change", () => {
  findIdx = -1;
  updateFindCount(currentMatches());
});
findQ.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); findNext(); }
});
findR.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); replaceCurrent(); }
});
findbarEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); closeFindBar(); }
});
document.getElementById("find-next")?.addEventListener("click", findNext);
document.getElementById("find-repl")?.addEventListener("click", replaceCurrent);
document.getElementById("find-repl-all")?.addEventListener("click", replaceAllFromBar);
document.getElementById("find-close")?.addEventListener("click", closeFindBar);

// ---------- ribbon (WO-39) ----------
import { buildRibbon } from "../../shared/ribbon";

function setBlockViaRibbon(type: Block["type"]): void {
  readSelection();
  dispatch("setBlockType", type);
  editor.focus();
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
            { kind: "ph", label: "Paste", icon: "📋", big: true },
            { kind: "ph", label: "Cut", icon: "✂" },
            { kind: "ph", label: "Copy", icon: "⿻" },
            { kind: "ph", label: "Format Painter", icon: "🖌" },
          ],
        },
        {
          name: "Font",
          controls: [
            { kind: "ph", label: "Calibri (Body)" },
            { kind: "ph", label: "11" },
            { kind: "move", id: "btn-bold" },
            { kind: "move", id: "btn-italic" },
            { kind: "move", id: "btn-underline" },
            { kind: "move", id: "btn-strike" },
            { kind: "ph", label: "x₂" },
            { kind: "ph", label: "x²" },
            { kind: "ph", label: "A", icon: "🖍" },
          ],
        },
        {
          name: "Paragraph",
          controls: [
            { kind: "action", label: "⁝≡", title: "Bullets", onClick: () => setBlockViaRibbon("bullet") },
            { kind: "action", label: "1≡", title: "Numbering", onClick: () => setBlockViaRibbon("numbered") },
            { kind: "action", label: "⇤", title: "Decrease Indent (Shift+Tab)", onClick: () => { readSelection(); dispatch("outdentList"); editor.focus(); } },
            { kind: "action", label: "⇥", title: "Increase Indent (Tab)", onClick: () => { readSelection(); dispatch("indentList"); editor.focus(); } },
            { kind: "ph", label: "≡", icon: "" },
            { kind: "ph", label: "Line Spacing" },
            { kind: "ph", label: "Borders" },
          ],
        },
        {
          name: "Styles",
          controls: [
            { kind: "action", label: "Normal", big: true, icon: "¶", title: "Normal paragraph", onClick: () => setBlockViaRibbon("paragraph") },
            { kind: "action", label: "Heading 1", big: true, icon: "H₁", title: "Heading 1", onClick: () => setBlockViaRibbon("heading1") },
            { kind: "action", label: "Heading 2", big: true, icon: "H₂", title: "Heading 2", onClick: () => setBlockViaRibbon("heading2") },
            { kind: "move", id: "block-type" },
          ],
        },
        {
          name: "Editing",
          controls: [
            { kind: "action", label: "Find &\nReplace", big: true, icon: "🔍", title: "Find & Replace (Ctrl/Cmd-F)", onClick: () => openFindBar() },
            { kind: "ph", label: "Select", icon: "⬚" },
          ],
        },
      ],
    },
    {
      name: "Insert",
      groups: [
        { name: "Pages", controls: [{ kind: "ph", label: "Cover Page", big: true, icon: "📄" }, { kind: "ph", label: "Page Break" }] },
        { name: "Tables", controls: [{ kind: "move", id: "btn-table", label: "Table", icon: "⊞", big: true, title: "Insert 3×3 table" }] },
        {
          name: "Illustrations",
          controls: [
            { kind: "ph", label: "Pictures", big: true, icon: "🖼" },
            { kind: "ph", label: "Shapes", icon: "⬠" },
            { kind: "ph", label: "Icons", icon: "☆" },
            { kind: "ph", label: "Chart", icon: "📊" },
          ],
        },
        { name: "Links", controls: [{ kind: "ph", label: "Link", big: true, icon: "🔗" }, { kind: "ph", label: "Bookmark" }] },
        { name: "Header & Footer", controls: [{ kind: "ph", label: "Header" }, { kind: "ph", label: "Footer" }, { kind: "ph", label: "Page Number" }] },
        { name: "Symbols", controls: [{ kind: "ph", label: "Equation", icon: "π" }, { kind: "ph", label: "Symbol", icon: "Ω" }] },
      ],
    },
    {
      name: "Review",
      groups: [
        { name: "Proofing", controls: [{ kind: "ph", label: "Spelling &\nGrammar", big: true, icon: "✓" }, { kind: "ph", label: "Word Count" }] },
        { name: "Comments", controls: [{ kind: "ph", label: "New\nComment", big: true, icon: "💬" }] },
        {
          name: "Tracking",
          controls: [
            { kind: "move", id: "btn-revisions", label: "Revisions", icon: "⧗", big: true, title: "Revisions: save, compare, restore" },
            { kind: "ph", label: "Track Changes", icon: "📝" },
          ],
        },
      ],
    },
    {
      name: "File",
      groups: [
        {
          name: "Document",
          controls: [
            { kind: "move", id: "btn-new", label: "New", icon: "🗎", big: true },
            { kind: "move", id: "btn-open", label: "Open", icon: "📂", big: true },
            { kind: "move", id: "doc-list" },
            { kind: "move", id: "btn-delete", label: "Delete" },
          ],
        },
        {
          name: "Export",
          controls: [
            { kind: "move", id: "btn-export-docx", label: "Word\n(.docx)", icon: "⬇", big: true },
            { kind: "move", id: "btn-export-pdf", label: "PDF", icon: "⬇", big: true },
            { kind: "move", id: "btn-export-md", label: "Markdown" },
            { kind: "move", id: "btn-export-html", label: "HTML" },
            { kind: "move", id: "btn-export-json", label: "JSON" },
          ],
        },
      ],
    },
  ],
  ["btn-undo", "btn-redo"]
);
