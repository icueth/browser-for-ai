import type { ElementHandle, Page } from "puppeteer-core";

/** Clear-and-type for text-like controls. A <select> cannot be "typed into" — typing drives Chrome's
 *  type-ahead and can silently land on the wrong option — so it gets a real option select by value.
 *  Shared by page_fill and page_batch's fill step. */
export async function fillElement(page: Page, el: ElementHandle<Element>, value: string): Promise<"typed" | "selected"> {
  const tag = await el.evaluate((e) => e.tagName.toLowerCase());
  if (tag === "select") {
    await (el as ElementHandle<HTMLSelectElement>).select(value);
    return "selected";
  }
  await el.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await el.type(value);
  return "typed";
}
