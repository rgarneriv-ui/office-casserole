// Builds all app slices: bundle.js + index.html + self-contained standalone.
import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";

const apps = ["write", "sheets", "slides"];

for (const app of apps) {
  const out = `apps/${app}/dist`;
  await mkdir(out, { recursive: true });
  await build({
    entryPoints: [`apps/${app}/src/main.ts`],
    bundle: true,
    format: "iife",
    target: "es2020",
    outfile: `${out}/bundle.js`,
    logLevel: "info",
  });
  await copyFile(`apps/${app}/index.html`, `${out}/index.html`);
  const html = await readFile(`apps/${app}/index.html`, "utf8");
  const js = await readFile(`${out}/bundle.js`, "utf8");
  await writeFile(
    `${out}/index.standalone.html`,
    // replacer function: the bundle may contain $-patterns ($&, $', …) that a
    // plain replacement string would expand
    html.replace('<script src="bundle.js"></script>', () => `<script>\n${js}\n</script>`)
  );
  console.log(`${app} built → ${out}/`);
}
