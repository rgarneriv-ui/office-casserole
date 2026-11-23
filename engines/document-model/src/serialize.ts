/**
 * Serialization (spec §5.2): JSON (native, lossless), HTML (lossless for this
 * model subset), Markdown (lossy — emits a loss report rather than claiming
 * fidelity; §5.2 "must not claim complete fidelity").
 */

import { Block, DocModel, SCHEMA_VERSION } from "./types";
import { normalizeModel, validateModel } from "./model";
import { ListCounter } from "./listmarks";

export interface LossWarning {
  code: string;
  message: string;
  blockIndex: number;
}

export interface LossReport {
  format: string;
  lossless: boolean;
  warnings: LossWarning[];
}

export function toJSON(model: DocModel): string {
  return JSON.stringify(model, null, 2);
}

export function fromJSON(json: string): DocModel {
  const parsed = JSON.parse(json) as DocModel;
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported document schema ${parsed.schemaVersion}`);
  }
  normalizeModel(parsed);
  const errors = validateModel(parsed);
  if (errors.length > 0) {
    throw new Error(`Invalid document: ${errors.join("; ")}`);
  }
  return parsed;
}

/** Word highlight palette → CSS colors (same mapping as the DOCX converter). */
export const HIGHLIGHT_CSS: Record<string, string> = {
  yellow: "#ffff00",
  green: "#00ff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  red: "#ff0000",
  blue: "#0000ff",
  darkYellow: "#808000",
  lightGray: "#c0c0c0",
};

function escapeAttr(text: string): string {
  return escapeHtml(text);
}

function blockStyleAttr(block: Block): string {
  const styles: string[] = [];
  if (block.align && block.align !== "left") styles.push(`text-align:${block.align}`);
  if (block.spacing && block.spacing !== 1) styles.push(`line-height:${block.spacing * 1.45}`);
  if (block.pageBreakBefore) styles.push("page-break-before:always");
  return styles.length > 0 ? ` style="${styles.join(";")}"` : "";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const HTML_TAG: Record<string, string> = {
  paragraph: "p",
  heading1: "h1",
  heading2: "h2",
};

function runsHtml(block: Pick<Block, "runs">): string {
  return (
    block.runs
      .map((run) => {
        if (run.image) {
          const dims = `${run.imageW ? ` width="${Math.round(run.imageW * (96 / 72))}"` : ""}${run.imageH ? ` height="${Math.round(run.imageH * (96 / 72))}"` : ""}`;
          return `<img src="${run.image}"${dims} alt=""/>`;
        }
        let html = escapeHtml(run.text);
        if (run.marks.includes("bold")) html = `<strong>${html}</strong>`;
        if (run.marks.includes("italic")) html = `<em>${html}</em>`;
        if (run.marks.includes("underline")) html = `<u>${html}</u>`;
        if (run.marks.includes("strike")) html = `<s>${html}</s>`;
        const styles: string[] = [];
        if (run.size) styles.push(`font-size:${run.size}pt`);
        if (run.color) styles.push(`color:${run.color}`);
        if (run.highlight) styles.push(`background:${HIGHLIGHT_CSS[run.highlight] ?? run.highlight}`);
        if (run.font) styles.push(`font-family:'${run.font}'`);
        if (styles.length > 0) html = `<span style="${styles.join(";")}">${html}</span>`;
        if (run.link) html = `<a href="${escapeAttr(run.link)}">${html}</a>`;
        return html;
      })
      .join("") || "<br>"
  );
}

export function toHTML(model: DocModel): string {
  const parts: string[] = [];
  // stack of open lists: each entry is its tag; an <li> stays open until its
  // subtree (deeper lists) closes, so nesting is valid HTML
  const stack: { tag: "ul" | "ol"; liOpen: boolean }[] = [];
  const closeLi = () => {
    const top = stack[stack.length - 1];
    if (top?.liOpen) {
      parts.push("</li>");
      top.liOpen = false;
    }
  };
  const closeOne = () => {
    closeLi();
    const top = stack.pop();
    if (top) parts.push(`</${top.tag}>`);
    closeLi(); // the parent li that contained this nested list
  };
  const closeAll = () => {
    while (stack.length > 0) closeOne();
  };
  for (const block of model.blocks) {
    if (block.type === "table" && block.table) {
      closeAll();
      const style = block.tableStyle ?? {};
      const cols = block.table[0]!.length;
      const widths = style.widths;
      const total = widths ? widths.reduce((a, b) => a + b, 0) : 0;
      const colgroup = widths
        ? `<colgroup>${widths.map((w) => `<col style="width:${((w / total) * 100).toFixed(1)}%"/>`).join("")}</colgroup>\n`
        : "";
      const cellTag = (r: number) => (style.headerRow && r === 0 ? "th" : "td");
      const alignAttr = (c: number) =>
        style.aligns?.[c] ? ` style="text-align:${style.aligns[c]}"` : "";
      const rows = block.table
        .map(
          (row, r) =>
            `<tr>${row
              .map((cell, c) => `<${cellTag(r)}${alignAttr(c)}>${escapeHtml(cell)}</${cellTag(r)}>`)
              .join("")}</tr>`
        )
        .join("\n");
      parts.push(`<table border="1" cellspacing="0" cellpadding="4">\n${colgroup}${rows}\n</table>`);
      void cols;
      continue;
    }
    if (block.type === "bullet" || block.type === "numbered") {
      const want: "ul" | "ol" = block.type === "bullet" ? "ul" : "ol";
      // a list can nest at most one level deeper than its parent: clamp
      // skipped levels to the current depth so the HTML stays valid
      const level = Math.min(3, block.indent ?? 0, stack.length);
      while (stack.length > level + 1) closeOne();
      if (stack.length === level + 1 && stack[level]!.tag !== want) closeOne();
      while (stack.length < level + 1) {
        // deeper list opens inside the (still open) parent li
        parts.push(`<${want}>`);
        stack.push({ tag: want, liOpen: false });
      }
      closeLi();
      parts.push(`<li>${runsHtml(block)}`);
      stack[stack.length - 1]!.liOpen = true;
      continue;
    }
    closeAll();
    const tag = HTML_TAG[block.type] ?? "p";
    parts.push(`<${tag}${blockStyleAttr(block)}>${runsHtml(block)}</${tag}>`);
  }
  closeAll();
  return parts.join("\n");
}

function escapeMd(text: string): string {
  return text.replace(/([\\`*_#])/g, "\\$1");
}

export function toMarkdown(model: DocModel): { markdown: string; report: LossReport } {
  const warnings: LossWarning[] = [];
  const lines: string[] = [];
  const counter = new ListCounter();
  model.blocks.forEach((block, bi) => {
    if (block.type === "table" && block.table) {
      counter.next("paragraph", 0);
      const esc = (c: string) => {
        if (c.includes("\n")) {
          warnings.push({
            code: "MD-TABLE-MULTILINE",
            message: "Multi-line table cells flattened to one line in Markdown.",
            blockIndex: bi,
          });
        }
        return c.replace(/\n/g, " ").replace(/\|/g, "\\|");
      };
      const t = block.table;
      const aligns = block.tableStyle?.aligns;
      const sep = (c: number) => {
        const a = aligns?.[c];
        return a === "center" ? " :---: " : a === "right" ? " ---: " : a === "left" ? " :--- " : " --- ";
      };
      const line = (row: string[]) => `| ${row.map(esc).join(" | ")} |`;
      const md = [line(t[0]!), `|${t[0]!.map((_, c) => sep(c)).join("|")}|`, ...t.slice(1).map(line)];
      lines.push(md.join("\n"));
      return;
    }
    const level = Math.min(3, block.indent ?? 0);
    counter.next(block.type, level);
    const listPad = "    ".repeat(level);
    const prefix =
      block.type === "heading1"
        ? "# "
        : block.type === "heading2"
          ? "## "
          : block.type === "bullet"
            ? `${listPad}- `
            : block.type === "numbered"
              ? `${listPad}${counter.lastCount}. `
              : "";
    const text = block.runs
      .map((run) => {
        let md = escapeMd(run.text);
        if (run.marks.includes("bold")) md = `**${md}**`;
        if (run.marks.includes("italic")) md = `*${md}*`;
        if (run.marks.includes("strike")) md = `~~${md}~~`; // GFM strikethrough
        if (run.link) md = `[${md}](${run.link})`;
        if (run.image) {
          warnings.push({
            code: "MD-IMAGE-EMBEDDED",
            message: "Inline image exported as a data-URL Markdown image (large output).",
            blockIndex: bi,
          });
          return `![image](${run.image})`;
        }
        if (run.size || run.color || run.highlight || run.font) {
          warnings.push({
            code: "MD-RUNPROPS-LOST",
            message: "Font size/color/highlight/family have no Markdown representation; exported as plain text.",
            blockIndex: bi,
          });
        }
        if (run.marks.includes("underline")) {
          warnings.push({
            code: "MD-UNDERLINE-LOST",
            message:
              "Underline has no standard Markdown representation; exported as plain text.",
            blockIndex: bi,
          });
        }
        return md;
      })
      .join("");
    lines.push(prefix + text);
  });
  return {
    markdown: lines.join("\n\n") + "\n",
    report: { format: "markdown", lossless: warnings.length === 0, warnings },
  };
}
