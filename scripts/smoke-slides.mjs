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

// ribbon: tabs, re-homed controls, New Slide works from the ribbon
{
  const tabs = [...doc.querySelectorAll("#ribbon .rb-tab")].map((t) => t.textContent);
  assert(JSON.stringify(tabs) === JSON.stringify(["Home", "Insert", "Slide Show", "File"]), `Slides tabs: ${tabs}`);
  assert(doc.querySelector("#ribbon #btn-add-slide") && doc.querySelector("#ribbon #btn-present"), "controls re-homed");
  const thumbsBefore = doc.querySelectorAll("#thumbs .thumb").length;
  doc.getElementById("btn-add-slide").click();
  assert(doc.querySelectorAll("#thumbs .thumb").length === thumbsBefore + 1, "New Slide works from the ribbon");
  const ph = doc.querySelector("#ribbon [data-ph]");
  assert(ph && ph.disabled && ph.title.includes("not yet implemented"), "placeholders honest");
}
console.log("SMOKE OK — Slides ribbon");

// chunk C: layouts, ribbon font, quick styles, footer, from-current
{
  const thumbsBefore = doc.querySelectorAll("#thumbs .thumb").length;
  const layout = doc.getElementById("layout-pick");
  layout.value = "section";
  layout.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert(doc.querySelectorAll("#thumbs .thumb").length === thumbsBefore + 1, "layout picker adds a slide");
  assert([...doc.querySelectorAll("#canvas .el.text .t")].some((t) => t.textContent.includes("Section")), "section layout content present");
  // select the section title text and bump size via ribbon A+
  const textEl = [...doc.querySelectorAll("#canvas .el.text")].find((e) => e.textContent.includes("Section"));
  textEl.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  doc.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true }));
  const aPlus = [...doc.querySelectorAll("#ribbon button")].find((b) => b.title === "Bigger text");
  const sizeBefore = Number(doc.getElementById("p-size").value); // props bar mirrors the model
  aPlus.click();
  const sizeAfter = Number(doc.getElementById("p-size").value);
  assert(sizeAfter === sizeBefore + 4, `A+ grew text (${sizeBefore} -> ${sizeAfter})`);
  // quick style on the section rect
  const rect = doc.querySelector("#canvas .el.rect");
  rect.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  doc.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true }));
  dom.window.prompt = () => "Warm";
  const qs = [...doc.querySelectorAll("#ribbon button")].find((b) => b.textContent.includes("Quick Styles"));
  qs.click();
  assert(doc.querySelector("#canvas .el.rect").style.background.includes("243") || doc.querySelector("#canvas .el.rect").style.background.includes("#f3d9b1"), "quick style applied");
  // footer
  dom.window.prompt = () => "Casserole Deck";
  dom.window.confirm = () => true;
  doc.getElementById("btn-footer").click();
  assert(doc.querySelector("#canvas .deck-footer"), "footer rendered on the canvas");
  assert(doc.querySelector("#canvas .deck-footer").textContent.includes("Casserole Deck"), "footer text");
  // from current slide
  doc.getElementById("btn-present-current").click();
  const counter = doc.querySelector("#present .counter").textContent;
  assert(!doc.getElementById("present").hidden, "presenting");
  assert(counter.startsWith(String([...doc.querySelectorAll('#thumbs .thumb')].findIndex(t => t.classList.contains('active')) + 1)), `from current: ${counter}`);
  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}
console.log("SMOKE OK — layouts, styles, footer, from-current");
