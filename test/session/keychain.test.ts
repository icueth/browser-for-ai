import { describe, it, expect } from "vitest";
import { keychainOverrides } from "../../src/session/manager";

describe("keychainOverrides — persistent logins survive", () => {
  it("drops --use-mock-keychain and --password-store=basic for a named profile", () => {
    // Without this, Chrome can't decrypt real-keystore cookies and wipes the jar → silent logout.
    expect(keychainOverrides("work")).toEqual({
      ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
    });
  });

  it("keeps puppeteer's defaults for an ephemeral (unnamed) profile — nothing to preserve", () => {
    expect(keychainOverrides(undefined)).toEqual({});
  });
});
