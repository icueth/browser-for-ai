import type { ElementHandle, Page } from "puppeteer-core";
import { z } from "zod";

export interface Target {
  ref?: string;
  selector?: string;
}

/** Zod raw fields shared by every interaction tool that targets an element. */
export const targetFields = {
  ref: z.string().optional(),
  selector: z.string().optional(),
};

// Our own ids assigned by page_snapshot (data-bfa-ref="e1", "e2", ...) — never user input,
// but validated anyway so a stale/typo'd ref fails with a clear message instead of a silent
// no-match.
const REF_PATTERN = /^e\d+$/;

/** Pure guard: exactly one of ref/selector must be set. Extracted from resolveTarget so it's
 *  unit-testable without a Page. */
export function assertExactlyOne(t: Target, tool: string): void {
  const count = (t.ref ? 1 : 0) + (t.selector ? 1 : 0);
  if (count !== 1) {
    throw new Error(`${tool}: provide exactly one of ref/selector`);
  }
}

/** Formats a target for error/note messages, e.g. `ref "e3"` or `selector ".x"`. */
export function describeTarget(t: Target): string {
  return t.ref ? `ref "${t.ref}"` : `selector "${t.selector}"`;
}

export async function resolveTarget(page: Page, t: Target, tool: string): Promise<ElementHandle<Element>> {
  assertExactlyOne(t, tool);

  let el: ElementHandle<Element> | null;
  if (t.ref) {
    if (!REF_PATTERN.test(t.ref)) {
      throw new Error(`${tool}: invalid ref "${t.ref}" — refs look like "e1", "e2" (from page_snapshot)`);
    }
    el = await page.$(`[data-bfa-ref="${t.ref}"]`);
  } else {
    el = await page.$(t.selector!);
  }

  if (!el) {
    throw new Error(`no element for ${describeTarget(t)} — run page_snapshot again`);
  }
  return el;
}
