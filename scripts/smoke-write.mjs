import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const html = await readFile("apps/write/dist/index.standalone.html", "utf8");
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://example.test/" });
await new Promise(r => setTimeout(r, 200));
const doc = dom.window.document;
const editor = doc.getElementById("editor");
const codes = doc.getElementById("codes");
const assert = (cond, msg) => { if (!cond) { console.error("SMOKE FAIL:", msg); process.exit(1); } };

assert(editor, "editor element exists");
assert(editor.querySelectorAll("[data-block]").length === 2, "seed doc renders 2 blocks, got " + editor.querySelectorAll("[data-block]").length);
assert(editor.textContent.includes("Casserole Write"), "seed heading rendered");
assert(codes.querySelectorAll(".code").length > 5, "codes panel populated: " + codes.querySelectorAll(".code").length);
assert(codes.textContent.includes("[Heading 1]"), "block code present");
assert(codes.textContent.includes("[Bold On]"), "mark code present");
assert(dom.window.localStorage.getItem("casserole-write:v1:default-doc") === null, "no premature save before edit");
console.log("SMOKE OK — blocks:", editor.querySelectorAll("[data-block]").length, "codes:", codes.querySelectorAll(".code").length);
