// Builds apps/write into dist/: bundle.js + index.html, and a single
// self-contained index.standalone.html (bundle inlined) for artifact hosting.
import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";

const out = "apps/write/dist";
await mkdir(out, { recursive: true });

await build({
  entryPoints: ["apps/write/src/main.ts"],
  bundle: true,
  format: "iife",
  target: "es2020",
  outfile: `${out}/bundle.js`,
  logLevel: "info",
});

await copyFile("apps/write/index.html", `${out}/index.html`);

const html = await readFile("apps/write/index.html", "utf8");
const js = await readFile(`${out}/bundle.js`, "utf8");
const standalone = html.replace(
  '<script src="bundle.js"></script>',
  `<script>\n${js}\n</script>`
);
await writeFile(`${out}/index.standalone.html`, standalone);
console.log("write app built:", `${out}/index.html`, "+ standalone");
