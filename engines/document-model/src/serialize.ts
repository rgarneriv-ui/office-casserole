/**
 * Serialization (spec §5.2): JSON (native, lossless), HTML (lossless for this
 * model subset), Markdown (lossy — emits a loss report rather than claiming
 * fidelity; §5.2 "must not claim complete fidelity").
 */

import { DocModel, SCHEMA_VERSION } from "./types";
import { normalizeModel, validateModel } from "./model";

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

function runsHtml(block: { runs: { text: string; marks: string[] }[] }): string {
  return (
    block.runs
      .map((run) => {
        let html = escapeHtml(run.text);
        if (run.marks.includes("bold")) html = `<strong>${html}</strong>`;
        if (run.marks.includes("italic")) html = `<em>${html}</em>`;
        if (run.marks.includes("underline")) html = `<u>${html}</u>`;
        return html;
      })
      .join("") || "<br>"
  );
}

export function toHTML(model: DocModel): string {
  const parts: string[] = [];
  let openList: "ul" | "ol" | null = null;
  const closeList = () => {
    if (openList) {
      parts.push(`</${openList}>`);
      openList = null;
    }
  };
  for (const block of model.blocks) {
    if (block.type === "table" && block.table) {
      closeList();
      const rows = block.table
        .map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
        .join("\n");
      parts.push(`<table border="1" cellspacing="0" cellpadding="4">\n${rows}\n</table>`);
      continue;
    }
    if (block.type === "bullet" || block.type === "numbered") {
      const want = block.type === "bullet" ? "ul" : "ol";
      if (openList !== want) {
        closeList();
        parts.push(`<${want}>`);
        openList = want;
      }
      parts.push(`<li>${runsHtml(block)}</li>`);
      continue;
    }
    closeList();
    const tag = HTML_TAG[block.type] ?? "p";
    parts.push(`<${tag}>${runsHtml(block)}</${tag}>`);
  }
  closeList();
  return parts.join("\n");
}

function escapeMd(text: string): string {
  return text.replace(/([\\`*_#])/g, "\\$1");
}

export function toMarkdown(model: DocModel): { markdown: string; report: LossReport } {
  const warnings: LossWarning[] = [];
  const lines: string[] = [];
  let counter = 0;
  model.blocks.forEach((block, bi) => {
    if (block.type === "table" && block.table) {
      counter = 0;
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
      const line = (row: string[]) => `| ${row.map(esc).join(" | ")} |`;
      const md = [line(t[0]!), `|${t[0]!.map(() => " --- ").join("|")}|`, ...t.slice(1).map(line)];
      lines.push(md.join("\n"));
      return;
    }
    if (block.type === "numbered") counter += 1;
    else counter = 0;
    const prefix =
      block.type === "heading1"
        ? "# "
        : block.type === "heading2"
          ? "## "
          : block.type === "bullet"
            ? "- "
            : block.type === "numbered"
              ? `${counter}. `
              : "";
    const text = block.runs
      .map((run) => {
        let md = escapeMd(run.text);
        if (run.marks.includes("bold")) md = `**${md}**`;
        if (run.marks.includes("italic")) md = `*${md}*`;
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
