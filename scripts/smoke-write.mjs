// jsdom boot smoke test for the built Write app (dist/index.standalone.html).
// jsdom has no IndexedDB, so this also exercises the localStorage fallback and
// the v1 → v2 legacy-journal migration.
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const html = await readFile("apps/write/dist/index.standalone.html", "utf8");
const assert = (cond, msg) => { if (!cond) { console.error("SMOKE FAIL:", msg); process.exit(1); } };

async function bootDom(prepare) {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://example.test/",
  });
  if (prepare) prepare(dom);
  dom.window.document.open();
  dom.window.document.write(html);
  dom.window.document.close();
  await new Promise(r => setTimeout(r, 300));
  return dom;
}

// Scenario 1: fresh boot → seed document, saved durably, files list populated
{
  const dom = await bootDom();
  const doc = dom.window.document;
  const editor = doc.getElementById("editor");
  const codes = doc.getElementById("codes");
  assert(editor.querySelectorAll("[data-block]").length === 2, "seed doc renders 2 blocks");
  assert(editor.textContent.includes("Casserole Write"), "seed heading rendered");
  assert(codes.querySelectorAll(".code").length > 5, "codes panel populated");
  assert(codes.textContent.includes("[Heading 1]"), "block code present");
  assert(codes.textContent.includes("[Bold On]"), "mark code present");
  assert(doc.getElementById("doc-title").value === "Welcome to Casserole Write", "title set");
  assert(doc.getElementById("doc-list").options.length === 1, "files list has the seed doc");
  const index = JSON.parse(dom.window.localStorage.getItem("casserole-write:v2:index") ?? "[]");
  assert(index.length === 1, "seed doc persisted to fallback store");
}

// Scenario 2: legacy v1 journal migrates into the new store
{
  const legacy = {
    savedAt: "2026-11-20T10:00:00.000Z",
    doc: { schemaVersion: "1.0", blocks: [{ id: "L1", type: "paragraph", runs: [{ text: "legacy words", marks: [] }] }] },
  };
  const dom = await bootDom((d) =>
    d.window.localStorage.setItem("casserole-write:v1:default-doc", JSON.stringify(legacy))
  );
  const doc = dom.window.document;
  assert(doc.getElementById("editor").textContent.includes("legacy words"), "migrated doc opened");
  assert(doc.getElementById("doc-title").value === "Recovered document", "migration title");
  assert(dom.window.localStorage.getItem("casserole-write:v1:default-doc") === null, "legacy journal retired after successful migration");
}

console.log("SMOKE OK — fresh boot + legacy migration");

// Scenario 3: command palette — Ctrl-K opens, filter, Enter runs "New document"
{
  const dom = await bootDom();
  const doc = dom.window.document;
  const before = doc.getElementById("doc-list").options.length;
  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
  assert(!doc.getElementById("palette").hidden, "palette opens on Ctrl-K");
  const input = doc.getElementById("pal-input");
  input.value = "new doc";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert(doc.querySelectorAll("#pal-list .pal-item").length === 1, "filter narrows to one command");
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 300));
  assert(doc.getElementById("palette").hidden, "palette closes after run");
  assert(doc.getElementById("doc-list").options.length === before + 1, "New document command executed");
}
console.log("SMOKE OK — command palette");

// Scenario 4: revisions — save, modify via palette command, compare, restore
{
  const dom = await bootDom();
  const doc = dom.window.document;
  dom.window.prompt = () => "Baseline";
  dom.window.confirm = () => true;
  doc.getElementById("btn-revisions").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert(!doc.getElementById("revisions").hidden, "revisions panel opens");
  doc.getElementById("btn-rev-save").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert(doc.querySelectorAll("#rev-list .rev-item").length === 1, "revision saved");

  // change the document: run "Heading 2" via the palette (block 0 is heading1)
  doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
  const input = doc.getElementById("pal-input");
  input.value = "heading 2";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 100));
  assert(doc.querySelector('#editor [data-block="0"]').tagName === "H2", "palette command retyped block");

  // compare: one formatting-only change
  doc.getElementById("btn-revisions").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  doc.querySelector("#rev-list [data-compare]").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const diffText = doc.querySelector("#rev-list .rev-diff").textContent;
  assert(diffText.includes("1 changed"), "diff summary shows 1 changed: " + diffText);
  assert(diffText.includes("formatting only"), "formatting-only change identified");

  // restore brings the heading back
  doc.querySelector("#rev-list [data-restore]").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));
  assert(doc.querySelector('#editor [data-block="0"]').tagName === "H1", "restore recovered the revision");
}
console.log("SMOKE OK — revisions save/compare/restore");
