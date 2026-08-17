import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import { ok } from "../format/compact";
import { guard } from "./guard";

const DEFAULT_LIMIT = 200;

const INTERACTIVE_SELECTOR =
  'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [contenteditable=""], [contenteditable=true], [onclick]';

interface SnapshotItem {
  ref: string;
  tag: string;
  type?: string;
  role?: string;
  name: string;
  value?: string;
  href?: string;
}

/** Runs entirely inside the page via page.evaluate — must be self-contained (no closures
 *  over module scope) since puppeteer stringifies it and re-evaluates it in the browser. */
function collectSnapshot(selector: string): SnapshotItem[] {
  // Refs from a prior snapshot are stale as soon as the DOM changes — drop them so this
  // snapshot is the only source of truth.
  document.querySelectorAll("[data-bfa-ref]").forEach((el) => el.removeAttribute("data-bfa-ref"));

  const nodes = Array.from(document.querySelectorAll(selector));
  const out: SnapshotItem[] = [];
  let n = 0;

  for (const el of nodes) {
    if (el.getClientRects().length === 0) continue; // display:none or detached

    // getClientRects() alone still passes visibility:hidden/opacity:0 elements (they have a
    // layout box, just nothing painted) — puppeteer's click() derives a point from that box
    // regardless, so an untagged one would let the model click something it can't see (or
    // whatever is actually painted underneath it). Skip those too.
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;

    n++;
    const ref = "e" + n;
    el.setAttribute("data-bfa-ref", ref);

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");

    let name = "";
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) name = ariaLabel.trim();
    if (!name) {
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length > 0) {
        const text = Array.from(labels)
          .map((l) => l.textContent || "")
          .join(" ")
          .trim();
        if (text) name = text;
      }
    }
    if (!name) {
      const placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder.trim()) name = placeholder.trim();
    }
    if (!name) {
      const innerText = (el as HTMLElement).innerText;
      if (innerText && innerText.trim()) name = innerText.trim();
    }
    if (!name) {
      const alt = el.getAttribute("alt");
      if (alt && alt.trim()) name = alt.trim();
    }
    if (!name) {
      const title = el.getAttribute("title");
      if (title && title.trim()) name = title.trim();
    }
    if (!name) {
      const nameAttr = el.getAttribute("name");
      if (nameAttr && nameAttr.trim()) name = nameAttr.trim();
    }
    // Collapse embedded newlines/runs of whitespace (e.g. a <select>'s innerText fallback
    // concatenates its <option> texts) so every entry stays a single compact line.
    name = name.replace(/\s+/g, " ").trim().slice(0, 80);

    const item: SnapshotItem = { ref, tag, name };
    if (role) item.role = role;
    if (tag === "input") {
      item.type = (el as HTMLInputElement).type;
      item.value = (el as HTMLInputElement).value;
    } else if (tag === "textarea") {
      item.value = (el as HTMLTextAreaElement).value;
    } else if (tag === "select") {
      item.value = (el as HTMLSelectElement).value;
    }
    if (tag === "a") {
      const href = el.getAttribute("href");
      if (href) item.href = href;
    }

    out.push(item);
  }

  return out;
}

function formatLine(it: SnapshotItem): string {
  const typePart = it.type ? `(${it.type})` : "";
  let line = `[${it.ref}] ${it.tag}${typePart} "${it.name}"`;
  if (it.value) line += ` ="${it.value}"`;
  if (it.href) line += ` → ${it.href}`;
  return line;
}

export function registerSnapshotTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "page_snapshot",
    {
      description:
        "Snapshot the page's interactive elements (links, buttons, inputs, selects, textareas, ...) and assign each a stable ref (e1, e2, ...) via a data-bfa-ref attribute, usable by page_click/page_type/etc instead of a CSS selector. Re-run after any action that changes the DOM — refs from a prior snapshot are invalidated.",
      inputSchema: {
        sessionId: z.string().optional(),
        limit: z.number().int().positive().optional().describe("max elements to list, in document order (default 200)"),
      },
    },
    async ({ sessionId, limit }) =>
      guard(async () => {
        const page = mgr.pageFor(sessionId);
        const items = await page.evaluate(collectSnapshot, INTERACTIVE_SELECTOR);

        const cap = limit ?? DEFAULT_LIMIT;
        const shown = items.slice(0, cap);
        const lines = shown.map(formatLine);
        if (shown.length < items.length) {
          lines.push(`showing ${shown.length} of ${items.length}`);
        }

        return ok(lines.length > 0 ? lines.join("\n") : "(no interactive elements found)");
      }),
  );
}
