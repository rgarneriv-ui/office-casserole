// jsdom boot smoke test for the built Slides app.
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const html = await readFile("apps/slides/dist/index.standalone.html", "utf8");
const assert = (cond, msg) => { if (!cond) { console.error("SMOKE FAIL:", msg); process.exit(1); } };

const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://example.test/" });
await new Promise(r => setTimeout(r, 300));
const doc = dom.window.document;

assert(doc.querySelectorAll("#thumbs .thumb").length === 2, "seed deck has 2 slides");
assert(doc.querySelector("#canvas .el.text"), "canvas renders text elements");
assert(doc.body.textContent.includes("Title slide"), "title element rendered");

// add a slide via toolbar and verify model + thumbnails update and persist
doc.getElementById("btn-add-slide").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
assert(doc.querySelectorAll("#thumbs .thumb").length === 3, "slide added");
await new Promise(r => setTimeout(r, 700));
const saved = JSON.parse(dom.window.localStorage.getItem("casserole-slides:v1:default"));
assert(saved.slides.length === 3, "autosave persisted the new slide");

// undo removes it
doc.getElementById("btn-undo").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
assert(doc.querySelectorAll("#thumbs .thumb").length === 2, "undo restored 2 slides");

// present mode renders the stage
doc.getElementById("btn-present").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
assert(!doc.getElementById("present").hidden, "present mode shown");
assert(doc.querySelector("#present .stage .el"), "present stage renders elements");

console.log("SMOKE OK — slides boot, add/undo, autosave, present");

// inline editing: double-click opens overlay; typing + blur commits
{
  const el = doc.querySelector("#canvas .el.text");
  el.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
  const overlay = doc.querySelector("#canvas .edit-overlay");
  assert(overlay, "edit overlay opens on double-click");
  overlay.value = "Edited inline!";
  overlay.dispatchEvent(new dom.window.FocusEvent("blur"));
  await new Promise(r => setTimeout(r, 50));
  assert(!doc.querySelector("#canvas .edit-overlay"), "overlay closed on blur");
  assert(doc.getElementById("canvas").textContent.includes("Edited inline!"), "committed text rendered");
  console.log("SMOKE OK — inline editing commit");
}

// lines: add, props, pptx round-trip persistence
{
  doc.getElementById("btn-add-line").click();
  const lineEl = doc.querySelector(".el.line");
  assert(lineEl, "line element rendered");
  assert(doc.querySelector(".el.line svg line"), "svg line present");
  const flip = doc.getElementById("p-flip");
  assert(flip, "line props bar shown");
  const y1Before = doc.querySelector(".el.line svg line").getAttribute("y1");
  flip.click();
  const y1After = doc.querySelector(".el.line svg line").getAttribute("y1");
  assert(y1Before !== y1After, `flip changes direction (${y1Before} -> ${y1After})`);
  const arrow = doc.querySelector(".el.line svg marker");
  assert(arrow, "arrowhead marker rendered (line added with arrow)");
}
console.log("SMOKE OK — line element add/props");
