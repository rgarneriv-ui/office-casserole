// Compatibility fixture harness (spec §22.2–22.3).
//
// Drop real Office files into:
//   tests/fixtures/docx/*.docx
//   tests/fixtures/xlsx/*.xlsx
// and run:  node scripts/compat-fixtures.mjs
//
// Every fixture is imported through the conversion pipeline. The harness
// FAILS on crashes and invalid models (a fixture we cannot read safely is a
// defect), and RECORDS losses without failing (losses are honest, crashes are
// not). Each run writes a per-fixture report to tests/fixtures/reports/ so
// regressions in loss behavior are diffable in git.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const parseXml = (xml) => new (new JSDOM("").window.DOMParser)().parseFromString(xml, "application/xml");
const serializeXml = (el) => new (new JSDOM("").window.XMLSerializer)().serializeToString(el);

const { importDocx } = await import("../build/engines/format-conversion/src/docx.js");
const { importPptx } = await import("../build/engines/format-conversion/src/pptx.js");
const { validateDeck } = await import("../build/engines/presentation-model/src/model.js");
const { importXlsx } = await import("../build/engines/format-conversion/src/xlsx.js");
const { validateModel, docText } = await import("../build/engines/document-model/src/model.js");

async function listFixtures(dir) {
  try {
    return (await readdir(dir)).filter((f) => !f.startsWith("."));
  } catch {
    return [];
  }
}

await mkdir("tests/fixtures/reports", { recursive: true });
let failures = 0;
let total = 0;
const summary = [];

for (const name of await listFixtures("tests/fixtures/docx")) {
  total++;
  const path = `tests/fixtures/docx/${name}`;
  try {
    const bytes = new Uint8Array(await readFile(path));
    const { model, report } = await importDocx(bytes, parseXml, serializeXml);
    const errors = validateModel(model);
    if (errors.length > 0) throw new Error(`invalid model: ${errors.join("; ")}`);
    const out = {
      fixture: name,
      format: "docx",
      ok: true,
      blocks: model.blocks.length,
      chars: docText(model).length,
      lossless: report.lossless,
      warnings: report.warnings,
    };
    await writeFile(`tests/fixtures/reports/${name}.report.json`, JSON.stringify(out, null, 2) + "\n");
    summary.push(`OK   docx ${name} — ${out.blocks} blocks, ${report.warnings.length} warning(s)`);
  } catch (err) {
    failures++;
    summary.push(`FAIL docx ${name} — ${err.message}`);
  }
}

for (const name of await listFixtures("tests/fixtures/xlsx")) {
  total++;
  const path = `tests/fixtures/xlsx/${name}`;
  try {
    const bytes = new Uint8Array(await readFile(path));
    const { sheet, report } = await importXlsx(bytes, parseXml);
    const out = {
      fixture: name,
      format: "xlsx",
      ok: true,
      cells: sheet.entries().length,
      lossless: report.lossless,
      mismatches: report.warnings.filter((w) => w.code === "XLSX-IMPORT-VALUE-MISMATCH").length,
      warnings: report.warnings,
    };
    await writeFile(`tests/fixtures/reports/${name}.report.json`, JSON.stringify(out, null, 2) + "\n");
    summary.push(`OK   xlsx ${name} — ${out.cells} cells, ${out.mismatches} value mismatch(es), ${report.warnings.length} warning(s)`);
  } catch (err) {
    failures++;
    summary.push(`FAIL xlsx ${name} — ${err.message}`);
  }
}

for (const name of await listFixtures("tests/fixtures/pptx")) {
  total++;
  const path = `tests/fixtures/pptx/${name}`;
  try {
    const bytes = new Uint8Array(await readFile(path));
    const { deck, report } = await importPptx(bytes, parseXml);
    const errors = validateDeck(deck);
    if (errors.length > 0) throw new Error(`invalid deck: ${errors.join("; ")}`);
    const out = {
      fixture: name, format: "pptx", ok: true,
      slides: deck.slides.length,
      elements: deck.slides.reduce((n, s2) => n + s2.elements.length, 0),
      lossless: report.lossless, warnings: report.warnings,
    };
    await writeFile(`tests/fixtures/reports/${name}.report.json`, JSON.stringify(out, null, 2) + "\n");
    summary.push(`OK   pptx ${name} — ${out.slides} slides, ${out.elements} elements, ${report.warnings.length} warning(s)`);
  } catch (err) {
    failures++;
    summary.push(`FAIL pptx ${name} — ${err.message}`);
  }
}

console.log(summary.join("\n") || "No fixtures found — add real Office files under tests/fixtures/{docx,xlsx,pptx}/");
console.log(`\n${total - failures}/${total} fixtures imported cleanly`);
if (failures > 0) process.exit(1);
