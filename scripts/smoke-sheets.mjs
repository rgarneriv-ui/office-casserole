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
assert(cell("D2").textContent === "54", "formula computed (12*4.5)");
assert(cell("D6").textContent === "265.75", "SUM computed");
assert(cell("D8").textContent === "no", "IF computed");
assert(cell("D6").classList.contains("num"), "numeric styling applied");

// commit an edit through the formula bar and verify recalculation + autosave
const formula = doc.getElementById("formula");
doc.querySelector('td[data-addr="B2"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
formula.value = "100";
formula.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
formula.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
assert(cell("D2").textContent === "450", "edit ripples through =B2*C2, got " + cell("D2").textContent);
assert(cell("D6").textContent === "661.75", "SUM updated");
assert(cell("D8").textContent === "YES", "IF flipped");
await new Promise(r => setTimeout(r, 700));
const saved = JSON.parse(dom.window.localStorage.getItem("casserole-sheets:v1:default") ?? "[]");
assert(saved.some((e) => e.addr === "B2" && e.input === "100"), "autosave persisted the edit");

console.log("SMOKE OK — sheets boot, recalc ripple, autosave");
