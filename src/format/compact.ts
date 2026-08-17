import type { ToolResult } from "../types";

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ").trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join("\n");
}

export function truncate(text: string, max = 2000): string {
  if (text.length <= max) return text;
  const extra = text.length - max;
  return `${text.slice(0, max)}…(+${extra}c more)`;
}
