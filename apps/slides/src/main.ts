/**
 * Casserole Slides — Phase 3 vertical slice over engines/presentation-model.
 * Elements are real editable objects (§8.2): text boxes and rects on a
 * 1600×900 logical canvas, dragged/resized/edited in place, with undo,
 * autosave, present mode, and JSON export.
 */

import {
  CANVAS_H,
  CANVAS_W,
  DeckModel,
  SlideElement,
  addElement,
  addSlide,
  clampElement,
  deckFromJSON,
  deckToJSON,
  duplicateSlide,
  newDeck,
  rectElement,
  removeElement,
  removeSlide,
  textElement,
  updateElement,
  validateDeck,
} from "../../../engines/presentation-model/src/model";
import { History } from "../../../engines/document-model/src/history";
import { exportPptx } from "../../../engines/format-conversion/src/pptx";

const STORAGE_KEY = "casserole-slides:v1:default";

let deck: DeckModel = newDeck();
let current = 0;
let selectedId: string | null = null;
const history = new History<DeckModel>();

const thumbsEl = document.getElementById("thumbs") as HTMLElement;
const canvasEl = document.getElementById("canvas") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const presentEl = document.getElementById("present") as HTMLElement;
const propsEl = document.getElementById("props") as HTMLElement;

// ---------- persistence ----------
let saveTimer: number | null = null;
function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, deckToJSON(deck));
    statusEl.textContent = `Saved ${new Date().toLocaleTimeString()}`;
  } catch {
    statusEl.textContent = "Autosave unavailable — export JSON to keep your work";
  }
}
function scheduleSave(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 500);
}
function restore(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      deck = deckFromJSON(raw);
      statusEl.textContent = "Restored deck";
      return;
    }
  } catch {
    statusEl.textContent = "Stored deck unreadable; started fresh (storage left untouched until next save)";
  }
  deck = newDeck();
  addSlide(deck, 0);
  updateElement(deck, 1, deck.slides[1]!.elements[0]!.id, { text: "Why Casserole Slides" });
  updateElement(deck, 1, deck.slides[1]!.elements[1]!.id, {
    text:
      "• Real editable elements, not images\n• Drag to move, handle to resize\n• Double-click any text to edit\n• Undo/redo, autosave, present mode (▶)",
  });
}

// ---------- rendering ----------
function elementHtml(el: SlideElement, scale: number, selected: boolean): string {
  const style =
    `left:${el.x * scale}px;top:${el.y * scale}px;width:${el.w * scale}px;height:${el.h * scale}px;`;
  if (el.kind === "rect") {
    return `<div class="el rect${selected ? " sel" : ""}" data-id="${el.id}" style="${style}background:${el.fill ?? "#dbe7f0"}"></div>`;
  }
  const textStyle =
    `font-size:${(el.size ?? 36) * scale}px;font-weight:${el.bold ? 700 : 400};` +
    `text-align:${el.align ?? "left"};color:${el.color ?? "#222"};`;
  const text = (el.text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/\n/g, "<br>");
  return (
    `<div class="el text${selected ? " sel" : ""}" data-id="${el.id}" style="${style}">` +
    `<div class="t" style="${textStyle}">${text}</div>` +
    (selected ? `<div class="handle" data-handle="${el.id}"></div>` : "") +
    `</div>`
  );
}

function slideHtml(index: number, scale: number, selectable: boolean): string {
  const slide = deck.slides[index];
  if (!slide) return "";
  return slide.elements
    .map((el) => elementHtml(el, scale, selectable && el.id === selectedId))
    .join("");
}

function render(): void {
  const scale = canvasEl.clientWidth / CANVAS_W;
  canvasEl.innerHTML = slideHtml(current, scale, true);
  thumbsEl.innerHTML = deck.slides
    .map(
      (s, i) =>
        `<div class="thumb${i === current ? " active" : ""}" data-slide="${i}">` +
        `<div class="mini">${slideHtml(i, 160 / CANVAS_W, false)}</div>` +
        `<span class="n">${i + 1}</span></div>`
    )
    .join("");
  renderProps();
  const errors = validateDeck(deck);
  if (errors.length > 0) {
    console.error("DECK INVARIANT VIOLATION:", errors);
    statusEl.textContent = "⚠ internal model error — see console";
  }
}

function selectedElement(): SlideElement | null {
  return deck.slides[current]?.elements.find((e) => e.id === selectedId) ?? null;
}

function renderProps(): void {
  const el = selectedElement();
  if (!el) {
    propsEl.innerHTML = `<span class="hint">Select an element — or double-click text to edit it</span>`;
    return;
  }
  if (el.kind === "text") {
    propsEl.innerHTML =
      `<label>Size <input id="p-size" type="number" min="12" max="200" value="${el.size ?? 36}"></label>` +
      `<label><input id="p-bold" type="checkbox" ${el.bold ? "checked" : ""}> Bold</label>` +
      `<label>Align <select id="p-align">` +
      ["left", "center", "right"].map((a) => `<option ${a === (el.align ?? "left") ? "selected" : ""}>${a}</option>`).join("") +
      `</select></label>` +
      `<label>Color <input id="p-color" type="color" value="${el.color ?? "#222222"}"></label>`;
  } else {
    propsEl.innerHTML = `<label>Fill <input id="p-fill" type="color" value="${el.fill ?? "#dbe7f0"}"></label>`;
  }
  const patch = (p: Partial<SlideElement>) => {
    history.checkpoint(deck, "props");
    updateElement(deck, current, el.id, p);
    render();
    scheduleSave();
  };
  (document.getElementById("p-size") as HTMLInputElement | null)?.addEventListener("change", (e) =>
    patch({ size: Number((e.target as HTMLInputElement).value) || 36 })
  );
  (document.getElementById("p-bold") as HTMLInputElement | null)?.addEventListener("change", (e) =>
    patch({ bold: (e.target as HTMLInputElement).checked })
  );
  (document.getElementById("p-align") as HTMLSelectElement | null)?.addEventListener("change", (e) =>
    patch({ align: (e.target as HTMLSelectElement).value as SlideElement["align"] })
  );
  (document.getElementById("p-color") as HTMLInputElement | null)?.addEventListener("change", (e) =>
    patch({ color: (e.target as HTMLInputElement).value })
  );
  (document.getElementById("p-fill") as HTMLInputElement | null)?.addEventListener("change", (e) =>
    patch({ fill: (e.target as HTMLInputElement).value })
  );
}

// ---------- canvas interaction ----------
interface DragState {
  id: string;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  orig: { x: number; y: number; w: number; h: number };
  moved: boolean;
}
let drag: DragState | null = null;

canvasEl.addEventListener("pointerdown", (e) => {
  const handle = (e.target as HTMLElement).closest("[data-handle]") as HTMLElement | null;
  const elDiv = (e.target as HTMLElement).closest(".el") as HTMLElement | null;
  const scale = canvasEl.clientWidth / CANVAS_W;
  if (handle) {
    const el = selectedElement();
    if (!el) return;
    drag = { id: el.id, mode: "resize", startX: e.clientX, startY: e.clientY, orig: { ...el }, moved: false };
    canvasEl.setPointerCapture(e.pointerId);
    return;
  }
  if (elDiv) {
    const id = elDiv.dataset.id!;
    if (selectedId !== id) {
      selectedId = id;
      render();
    }
    const el = selectedElement();
    if (!el) return;
    drag = { id, mode: "move", startX: e.clientX, startY: e.clientY, orig: { ...el }, moved: false };
    canvasEl.setPointerCapture(e.pointerId);
  } else {
    selectedId = null;
    render();
  }
  void scale;
});

canvasEl.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const el = deck.slides[current]?.elements.find((x) => x.id === drag!.id);
  if (!el) return;
  const scale = canvasEl.clientWidth / CANVAS_W;
  const dx = (e.clientX - drag.startX) / scale;
  const dy = (e.clientY - drag.startY) / scale;
  if (!drag.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
    history.checkpoint(deck, "drag-" + drag.id);
    drag.moved = true;
  }
  if (!drag.moved) return;
  if (drag.mode === "move") {
    el.x = drag.orig.x + dx;
    el.y = drag.orig.y + dy;
  } else {
    el.w = drag.orig.w + dx;
    el.h = drag.orig.h + dy;
  }
  clampElement(el);
  render();
});

canvasEl.addEventListener("pointerup", () => {
  if (drag?.moved) scheduleSave();
  drag = null;
});

canvasEl.addEventListener("dblclick", (e) => {
  const elDiv = (e.target as HTMLElement).closest(".el.text") as HTMLElement | null;
  if (!elDiv) return;
  const el = deck.slides[current]?.elements.find((x) => x.id === elDiv.dataset.id);
  if (!el) return;
  const value = window.prompt("Edit text (\\n for line breaks preserved):", el.text ?? "");
  if (value === null) return;
  history.checkpoint(deck);
  updateElement(deck, current, el.id, { text: value });
  render();
  scheduleSave();
});

thumbsEl.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest("[data-slide]") as HTMLElement | null;
  if (!t) return;
  current = Number(t.dataset.slide);
  selectedId = null;
  render();
});

// ---------- toolbar ----------
function cmd(fn: () => void): void {
  history.checkpoint(deck);
  fn();
  render();
  scheduleSave();
}
document.getElementById("btn-add-slide")?.addEventListener("click", () =>
  cmd(() => {
    current = addSlide(deck, current);
    selectedId = null;
  })
);
document.getElementById("btn-dup-slide")?.addEventListener("click", () =>
  cmd(() => {
    current = duplicateSlide(deck, current);
    selectedId = null;
  })
);
document.getElementById("btn-del-slide")?.addEventListener("click", () => {
  if (!window.confirm("Delete this slide?")) return;
  cmd(() => {
    removeSlide(deck, current);
    current = Math.min(current, deck.slides.length - 1);
    selectedId = null;
  });
});
document.getElementById("btn-add-text")?.addEventListener("click", () =>
  cmd(() => {
    const el = textElement({ x: 400, y: 350, w: 800, h: 150, text: "New text" });
    addElement(deck, current, el);
    selectedId = el.id;
  })
);
document.getElementById("btn-add-rect")?.addEventListener("click", () =>
  cmd(() => {
    const el = rectElement({ x: 500, y: 300, w: 600, h: 300 });
    addElement(deck, current, el);
    selectedId = el.id;
  })
);
document.getElementById("btn-del-el")?.addEventListener("click", () => {
  if (!selectedId) return;
  cmd(() => {
    removeElement(deck, current, selectedId!);
    selectedId = null;
  });
});
document.getElementById("btn-undo")?.addEventListener("click", () => {
  const prev = history.undo(deck);
  if (prev) {
    deck = prev;
    current = Math.min(current, deck.slides.length - 1);
    selectedId = null;
    render();
    scheduleSave();
  }
});
document.getElementById("btn-redo")?.addEventListener("click", () => {
  const next = history.redo(deck);
  if (next) {
    deck = next;
    current = Math.min(current, deck.slides.length - 1);
    selectedId = null;
    render();
    scheduleSave();
  }
});

document.addEventListener("keydown", (e) => {
  if (!presentEl.hidden) {
    if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") showPresent(presentIndex + 1);
    else if (e.key === "ArrowLeft" || e.key === "PageUp") showPresent(presentIndex - 1);
    else if (e.key === "Escape") exitPresent();
    e.preventDefault();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
    e.preventDefault();
    (document.getElementById("btn-undo") as HTMLButtonElement).click();
  } else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
    e.preventDefault();
    (document.getElementById("btn-redo") as HTMLButtonElement).click();
  } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId && (e.target as HTMLElement).tagName !== "INPUT") {
    e.preventDefault();
    (document.getElementById("btn-del-el") as HTMLButtonElement).click();
  }
});

// ---------- present mode ----------
let presentIndex = 0;
function showPresent(index: number): void {
  presentIndex = Math.max(0, Math.min(index, deck.slides.length - 1));
  const stage = presentEl.querySelector(".stage") as HTMLElement;
  const scale = Math.min(window.innerWidth / CANVAS_W, window.innerHeight / CANVAS_H) * 0.94;
  stage.style.width = `${CANVAS_W * scale}px`;
  stage.style.height = `${CANVAS_H * scale}px`;
  stage.innerHTML = deck.slides[presentIndex]!.elements
    .map((el) => elementHtml(el, scale, false))
    .join("");
  (presentEl.querySelector(".counter") as HTMLElement).textContent =
    `${presentIndex + 1} / ${deck.slides.length}`;
}
function exitPresent(): void {
  presentEl.hidden = true;
}
document.getElementById("btn-present")?.addEventListener("click", () => {
  presentEl.hidden = false;
  showPresent(current);
});
presentEl.addEventListener("click", () => showPresent(presentIndex + 1));

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

document.getElementById("btn-export-json")?.addEventListener("click", () =>
  deliverBlob("deck.json", new Blob([deckToJSON(deck)], { type: "application/json" }))
);
document.getElementById("btn-export-pptx")?.addEventListener("click", async () => {
  try {
    const { bytes } = await exportPptx(deck);
    await deliverBlob(
      "deck.pptx",
      new Blob([bytes as BlobPart], {
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      })
    );
  } catch (err) {
    statusEl.textContent = `⚠ PPTX export failed: ${err instanceof Error ? err.message : String(err)}`;
  }
});

// ---------- boot ----------
restore();
render();
window.addEventListener("resize", render);
