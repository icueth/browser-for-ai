import { z } from "zod";
import type { NetworkConditions } from "puppeteer-core";
import { PredefinedNetworkConditions } from "puppeteer-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import { ok } from "../format/compact";
import { guard } from "./guard";

// Throughput fields are bytes/sec (CDP's unit). Presets mirror DevTools' own profiles;
// "Slow 3G"/"Fast 3G" come straight from puppeteer, "fast-4g" is our own definition.
const PRESETS: Record<"slow-3g" | "fast-3g" | "fast-4g", NetworkConditions> = {
  "slow-3g": PredefinedNetworkConditions["Slow 3G"],
  "fast-3g": PredefinedNetworkConditions["Fast 3G"],
  "fast-4g": { download: 4_000_000 / 8, upload: 3_000_000 / 8, latency: 20 },
};

/** DevTools' own presets top out at 20x; beyond a few hundred the renderer can't even process the
 *  reset command any more (measured), so the tab is bricked until the session ends. */
const MAX_CPU_RATE = 20;

/** Registers net_throttle — emulate degraded network + CPU for the session over CDP. Being
 *  CDP-native, this is a thin wrapper over puppeteer's own emulation, but it bundles the common
 *  presets and a reset into one tool so callers don't compose three primitives by hand. The
 *  applied state persists across navigations/reloads until reset or session close, and is
 *  surfaced by page_state so nobody has to guess why a page crawls. */
export function registerEmulateTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "net_throttle",
    {
      description:
        "Emulate network + CPU conditions for the session (CDP). Use a preset " +
        "(offline / slow-3g / fast-3g / fast-4g / none), or custom throughput+latency, plus an " +
        "optional CPU slowdown factor (max 20x). 'none' (the default) resets everything back to full speed. " +
        "The state persists across page_goto/reload until reset or the session closes (page_state shows it).",
      inputSchema: {
        sessionId: z.string().optional(),
        preset: z
          .enum(["none", "offline", "slow-3g", "fast-3g", "fast-4g"])
          .optional()
          .describe("canned profile; default 'none' resets to full speed"),
        offline: z.boolean().optional().describe("cut the network entirely (independent of preset)"),
        downloadKbps: z.number().nonnegative().optional().describe("custom download throughput, kilobits/s"),
        uploadKbps: z.number().nonnegative().optional().describe("custom upload throughput, kilobits/s"),
        latencyMs: z.number().nonnegative().optional().describe("custom added latency, ms"),
        cpuRate: z.number().min(1).max(MAX_CPU_RATE).optional().describe(`CPU slowdown factor: 1 = none, 4 = 4x slower (max ${MAX_CPU_RATE})`),
      },
    },
    async ({ sessionId, preset, offline, downloadKbps, uploadKbps, latencyMs, cpuRate }) =>
      guard(async () => {
        const page = mgr.pageFor(sessionId);
        const applied: string[] = [];
        const hasCustom = downloadKbps !== undefined || uploadKbps !== undefined || latencyMs !== undefined;

        // Offline is its own CDP switch — an explicit flag, or the "offline" preset.
        const goOffline = offline ?? preset === "offline";
        await page.setOfflineMode(goOffline);
        if (goOffline) applied.push("offline");

        // Throughput/latency: custom overrides win; else a named preset; else clear (null).
        // Skip when offline — setOfflineMode already severs the connection.
        if (!goOffline) {
          let conditions: NetworkConditions | null = null;
          if (hasCustom) {
            conditions = {
              download: ((downloadKbps ?? 0) * 1000) / 8,
              upload: ((uploadKbps ?? 0) * 1000) / 8,
              latency: latencyMs ?? 0,
            };
            applied.push(`custom(${downloadKbps ?? 0}kbps↓/${uploadKbps ?? 0}kbps↑/${latencyMs ?? 0}ms)`);
          } else if (preset && preset !== "none" && preset !== "offline") {
            conditions = PRESETS[preset];
            applied.push(preset);
          }
          await page.emulateNetworkConditions(conditions);
        }

        // CPU: an explicit rate (clamped defensively even though the schema caps it), or reset on a bare 'none'.
        if (cpuRate !== undefined) {
          const rate = Math.min(cpuRate, MAX_CPU_RATE);
          await page.emulateCPUThrottling(rate === 1 ? null : rate);
          if (rate > 1) applied.push(`cpu ${rate}x`);
        } else if (preset === "none" && !hasCustom && offline === undefined) {
          await page.emulateCPUThrottling(null);
        }

        mgr.setEmulationNote(sessionId, applied.length ? applied.join(", ") : null);
        return ok(applied.length ? `throttle applied: ${applied.join(", ")}` : "throttle reset (full speed)");
      }),
  );
}
