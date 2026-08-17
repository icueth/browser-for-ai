import type { Page } from "puppeteer-core";

/** Persisted snapshot of a page's login-relevant client state: cookies plus the origin's
 *  localStorage/sessionStorage. Deliberately does NOT capture IndexedDB/cache/service-worker
 *  state — cookies + web storage cover the vast majority of "stay logged in" needs. */
export interface StateBlob {
  url: string;
  origin: string;
  cookies: unknown[];
  local: Record<string, string>;
  session: Record<string, string>;
}

export async function saveState(page: Page): Promise<StateBlob> {
  const cookies = await page.cookies();
  const url = page.url();
  const origin = new URL(url).origin;
  const storage = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
  return { url, origin, cookies, local: storage.local, session: storage.session };
}

export async function restoreState(
  page: Page,
  blob: StateBlob,
): Promise<{ cookies: number; local: number; session: number }> {
  // Cookies and web storage are both origin-scoped, so restoring into a page on a different
  // origin would silently apply to the wrong site. Navigate to the saved origin first — a
  // best-effort goto, since the origin may be transiently unreachable but we still want to
  // apply whatever state we can (e.g. cookies, which don't require script execution to set).
  if (new URL(page.url()).origin !== blob.origin) {
    await page.goto(blob.origin).catch(() => {});
  }
  if (blob.cookies.length) await page.setCookie(...(blob.cookies as Parameters<Page["setCookie"]>[number][]));
  await page.evaluate(
    (b) => {
      for (const [k, v] of Object.entries(b.local)) localStorage.setItem(k, v);
      for (const [k, v] of Object.entries(b.session)) sessionStorage.setItem(k, v);
    },
    blob,
  );
  return {
    cookies: blob.cookies.length,
    local: Object.keys(blob.local).length,
    session: Object.keys(blob.session).length,
  };
}
