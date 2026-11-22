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
