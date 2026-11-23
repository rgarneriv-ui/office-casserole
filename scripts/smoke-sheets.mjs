// jsdom boot smoke test for the built Sheets app.
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const html = await readFile("apps/sheets/dist/index.standalone.html", "utf8");
const assert = (cond, msg) => { if (!cond) { console.error("SMOKE FAIL:", msg); process.exit(1); } };

const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://example.test/" });
await new Promise(r => setTimeout(r, 300));
const doc = dom.window.document;

const cell = (addr) => doc.querySelector(`td[data-addr="${addr}"]`);
assert(doc.querySelectorAll("td[data-addr]").length === 12 * 40, "grid rendered");
assert(cell("A1").textContent === "Item", "seed label");
assert(cell("D2").textContent === "$54.00", "formula computed + currency format (12*4.5)");
assert(cell("D6").textContent === "$265.75", "SUM computed, currency formatted");
assert(cell("D8").textContent === "no", "IF computed");
assert(cell("D6").classList.contains("num"), "numeric styling applied");

// commit an edit through the formula bar and verify recalculation + autosave
const formula = doc.getElementById("formula");
doc.querySelector('td[data-addr="B2"]').dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
doc.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true }));
formula.value = "100";
formula.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
formula.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
assert(cell("D2").textContent === "$450.00", "edit ripples through =B2*C2, got " + cell("D2").textContent);
assert(cell("D6").textContent === "$661.75", "SUM updated");
assert(cell("D8").textContent === "YES", "IF flipped");
await new Promise(r => setTimeout(r, 700));
const savedRaw = JSON.parse(dom.window.localStorage.getItem("casserole-sheets:v1:default") ?? "[]");
const saved = Array.isArray(savedRaw) ? savedRaw : savedRaw.cells;
assert(saved.some((e) => e.addr === "B2" && e.input === "100"), "autosave persisted the edit");

assert(cell("A1").classList.contains("bold"), "header cell styled bold");
// toggle a format from the toolbar and verify persistence includes it
doc.querySelector('td[data-addr="A2"]').dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
doc.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true }));
doc.getElementById("btn-bold").dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
assert(cell("A2").classList.contains("bold"), "toolbar bold applied");
await new Promise(r => setTimeout(r, 700));
const saved2Raw = JSON.parse(dom.window.localStorage.getItem("casserole-sheets:v1:default"));
const saved2 = Array.isArray(saved2Raw) ? saved2Raw : saved2Raw.cells;
assert(saved2.some(e => e.addr === "A2" && e.format && e.format.bold === true), "format persisted");
console.log("SMOKE OK — sheets boot, recalc ripple, formats, autosave");

// range selection, range formatting, copy/paste with formula rebasing
{
  const td = (a) => doc.querySelector(`td[data-addr="${a}"]`);
  const formula2 = doc.getElementById("formula");
  const down = (a) => td(a).dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  const key = (k, opts={}) => formula2.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));

  // shift-click selects B2:C3; bold applies to the whole range
  down("B2");
  doc.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true }));
  td("C3").dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, shiftKey: true }));
  doc.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true }));
  assert(doc.getElementById("addr").textContent === "B2:C3", "range label shows B2:C3, got " + doc.getElementById("addr").textContent);
  assert(td("C2").classList.contains("in-range"), "range highlighted");
  doc.getElementById("btn-bold").dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  assert(td("B2").classList.contains("bold") && td("C3").classList.contains("bold"), "bold applied across range");

  // copy D2 (=B2*C2) and paste at D10: refs rebase to B10*C10
  down("D2");
  doc.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true }));
  key("c", { ctrlKey: true });
  down("D10");
  doc.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true }));
  key("v", { ctrlKey: true });
  down("D10");
  doc.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true }));
  assert(formula2.value === "=B10*C10", "pasted formula rebased, got " + formula2.value);
}
console.log("SMOKE OK — range select, range format, copy/paste rebasing");

// fill handle: series continuation via grip drag
{
  const td = (a) => doc.querySelector(`td[data-addr="${a}"]`);
  const pdown = (el, opts={}) => el.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, ...opts }));
  const pup = () => doc.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true }));
  // seed a series in F2:F3
  const formula3 = doc.getElementById("formula");
  for (const [addr, v] of [["F2","5"],["F3","10"]]) {
    pdown(td(addr)); pup();
    formula3.value = v;
    formula3.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    formula3.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  }
  pdown(td("F2")); pup();
  td("F3").dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, shiftKey: true }));
  pup();
  const grip = doc.querySelector(".fill-grip");
  assert(grip, "fill grip rendered on selection corner");
  pdown(grip);
  td("F6").dispatchEvent(new dom.window.MouseEvent("pointerover", { bubbles: true }));
  pup();
  assert(td("F4").textContent === "15" && td("F5").textContent === "20" && td("F6").textContent === "25",
    `series filled: ${td("F4").textContent},${td("F5").textContent},${td("F6").textContent}`);
}
console.log("SMOKE OK — fill handle series");

// row heights: grip drag resizes and persists
{
  const rowGrip = doc.querySelector('.row-grip[data-rowgrip="1"]');
  assert(rowGrip, "row grip rendered");
  const tr = rowGrip.closest("tr");
  rowGrip.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientY: 100 }));
  doc.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientY: 130 }));
  doc.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true }));
  assert(tr.style.height === "54px", `row resized to ${tr.style.height} (expected 54px = 24 default + 30 drag)`);
  await new Promise((r) => setTimeout(r, 700)); // debounced save
  const key = Object.keys(dom.window.localStorage).find((k) => k.includes("sheet"));
  const stored = JSON.parse(dom.window.localStorage.getItem(key));
  assert(Array.isArray(stored.rows) && stored.rows.some((r) => r.row === 1), "row height persisted");
}
console.log("SMOKE OK — row heights");
