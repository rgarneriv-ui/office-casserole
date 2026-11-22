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
  DocRange,
  History,
  Mark,
  Position,
  blockText,
  clampPosition,
  deleteRange,
  fromJSON,
  insertText,
  inspect,
  explainAt,
  isCollapsed,
  marksAt,
  mergeWithPrevious,
  newDocument,
  normRange,
  rangeHasMark,
  setBlockType,
  splitBlock,
  toggleMark,
  toHTML,
  toJSON,
  toMarkdown,
  validateModel,
} from "../../../engines/document-model/src/index";

import { DocumentStore, newDocId, openBestStore } from "./store";
import { exportDocx, importDocx } from "../../../engines/format-conversion/src/docx";
import { exportPdf } from "../../../engines/pdf-engine/src/pdf";

const BLOCK_TAG: Record<string, string> = { paragraph: "p", heading1: "h1", heading2: "h2" };

// ---------- state ----------
let model: DocModel = newDocument();
let selection: DocRange = { anchor: { block: 0, offset: 0 }, focus: { block: 0, offset: 0 } };
let caretMarks: Mark[] | null = null; // pending marks for a collapsed caret
const history = new History();
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

async function save(): Promise<void> {
  if (!store) return;
  try {
    currentTitle = (titleEl?.value || "Untitled document").trim() || "Untitled document";
    await store.save({
      id: currentDocId,
      title: currentTitle,
      updatedAt: new Date().toISOString(),
      doc: JSON.parse(toJSON(model)),
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
  const tag = BLOCK_TAG[block.type] ?? "p";
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
  return `<${tag} data-block="${index}">${inner}</${tag}>`;
}

function render(): void {
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
      return `<span class="code ${cls}" data-code="${i}" title="block ${c.blockIndex + 1}, chars ${c.start}–${c.end}">${label}</span>`;
    })
    .join("");
  codesPanel.querySelectorAll(".code").forEach((el) => {
    el.addEventListener("click", () => {
      const c = inspect(model)[Number((el as HTMLElement).dataset.code)];
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
  (["bold", "italic", "underline"] as Mark[]).forEach((m) => {
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
  | "insertText"
  | "deleteBackward"
  | "deleteSelection"
  | "splitBlock"
  | "toggleMark"
  | "setBlockType"
  | "undo"
  | "redo";

function dispatch(id: CommandId, payload?: unknown): void {
  if (id === "undo") {
    const prev = history.undo(model);
    if (prev) {
      model = prev;
      selection = {
        anchor: clampPosition(model, selection.anchor),
        focus: clampPosition(model, selection.focus),
      };
      render();
      scheduleSave();
    }
    return;
  }
  if (id === "redo") {
    const next = history.redo(model);
    if (next) {
      model = next;
      selection = {
        anchor: clampPosition(model, selection.anchor),
        focus: clampPosition(model, selection.focus),
      };
      render();
      scheduleSave();
    }
    return;
  }

  const coalesceKey = id === "insertText" ? "type" : id === "deleteBackward" ? "del" : null;
  history.checkpoint(model, coalesceKey);

  switch (id) {
    case "insertText": {
      const text = String(payload ?? "");
      if (!isCollapsed(selection)) {
        const caret = deleteRange(model, selection);
        selection = { anchor: caret, focus: caret };
      }
      const marks =
        caretMarks ?? marksAt(model.blocks[selection.focus.block]!, selection.focus.offset);
      const caret = insertText(model, selection.focus, text, marks);
      selection = { anchor: caret, focus: caret };
      break;
    }
    case "deleteSelection": {
      const caret = deleteRange(model, selection);
      selection = { anchor: caret, focus: caret };
      break;
    }
    case "deleteBackward": {
      if (!isCollapsed(selection)) {
        const caret = deleteRange(model, selection);
        selection = { anchor: caret, focus: caret };
      } else if (selection.focus.offset > 0) {
        const caret = deleteRange(model, {
          anchor: { block: selection.focus.block, offset: selection.focus.offset - 1 },
          focus: selection.focus,
        });
        selection = { anchor: caret, focus: caret };
      } else if (selection.focus.block > 0) {
        const caret = mergeWithPrevious(model, selection.focus.block);
        selection = { anchor: caret, focus: caret };
      }
      break;
    }
    case "splitBlock": {
      if (!isCollapsed(selection)) {
        const caret = deleteRange(model, selection);
        selection = { anchor: caret, focus: caret };
      }
      const caret = splitBlock(model, selection.focus);
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
      toggleMark(model, selection, mark);
      break;
    }
    case "setBlockType": {
      setBlockType(model, selection, payload as Block["type"]);
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
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); dispatch("undo"); }
  else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); dispatch("redo"); }
  else if (k === "b") { e.preventDefault(); readSelection(); dispatch("toggleMark", "bold"); }
  else if (k === "i") { e.preventDefault(); readSelection(); dispatch("toggleMark", "italic"); }
  else if (k === "u") { e.preventDefault(); readSelection(); dispatch("toggleMark", "underline"); }
});

document.addEventListener("selectionchange", () => {
  if (document.activeElement === editor || editor.contains(window.getSelection()?.anchorNode ?? null)) {
    readSelection();
  }
});

// ---------- toolbar ----------
(["bold", "italic", "underline"] as Mark[]).forEach((m) => {
  document.getElementById(`btn-${m}`)?.addEventListener("mousedown", (e) => {
    e.preventDefault(); // keep editor selection
    readSelection();
    dispatch("toggleMark", m);
  });
});
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
    const { bytes, report } = await exportDocx(model);
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

function resetEditorState(newModel: DocModel, title: string, id: string): void {
  model = newModel;
  currentDocId = id;
  currentTitle = title;
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
    resetEditorState(fromJSON(JSON.stringify(stored.doc)), stored.title, stored.id);
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
