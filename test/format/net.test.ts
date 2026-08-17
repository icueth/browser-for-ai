import { describe, it, expect } from "vitest";
import { netDetail } from "../../src/format/net";
import type { NetEntry } from "../../src/recorder/types";

function entry(overrides: Partial<NetEntry> = {}): NetEntry {
  return {
    id: "1",
    seq: 1,
    method: "POST",
    url: "https://api.example.com/v1/pay",
    resourceType: "Fetch",
    requestHeaders: {
      "content-type": "application/json",
      authorization: "Bearer abc.def.ghi",
      "x-api-key": "9f8c7b6a5d4e3f2a1b0c",
      agent: "mrbonus",
      time: "1723891200000",
    },
    hasPostData: true,
    status: 200,
    statusText: "OK",
    mimeType: "application/json",
    responseHeaders: { "content-type": "application/json", "x-signature": "sig123" },
    startTs: 0,
    finished: true,
    failed: false,
    ...overrides,
  };
}

describe("netDetail — full header fidelity", () => {
  // Regression: net_get used to render only a 7-header allowlist, so custom signing headers
  // (x-api-key/agent/time) were silently dropped — making a synthesized client look like it
  // only needed Authorization, then fail with an API-key error. net_get must show them all.
  it("shows EVERY request header, including custom signing headers", () => {
    const out = netDetail(entry(), '{"amount":100}', { body: '{"ok":true}', base64: false });
    for (const h of [
      "authorization: Bearer abc.def.ghi",
      "x-api-key: 9f8c7b6a5d4e3f2a1b0c",
      "agent: mrbonus",
      "time: 1723891200000",
    ]) {
      expect(out).toContain(h);
    }
  });

  it("shows every response header too", () => {
    const out = netDetail(entry(), null, { body: "{}", base64: false });
    expect(out).toContain("x-signature: sig123");
  });

  it("renders (none) when a request carries no headers", () => {
    const out = netDetail(entry({ requestHeaders: {} }), null, null);
    expect(out).toContain("request headers:\n  (none)");
  });
});
