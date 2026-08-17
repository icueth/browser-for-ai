import type { FlowDep, FlowDepTransform, FlowModel } from "./types";
import { matchValue } from "./match";

interface Producer {
  callIndex: number;
  source: string;
  transform: FlowDepTransform;
  claimPath?: string;
  container?: string;
}

/** Priority order, most-specific/most-conservative first (mirrors match.ts). */
const TRANSFORM_PRIORITY: FlowDepTransform[] = ["exact", "urlenc", "base64", "jwt-claim", "substring"];

/**
 * Find the earliest call before `beforeCallIndex` whose produced value relates
 * to `value` via exactly `transform` (see match.ts) — i.e. this is NOT a
 * general "find the earliest producer" search; it only considers producers
 * that match at this specific transform tier. The caller (`detectDeps`) runs
 * this once per transform tier, strongest first, so producer selection is
 * transform-tier-first (exact > urlenc > base64 > jwt-claim > substring),
 * THEN earliest-call-within-that-tier — not "earliest producer overall".
 * A later call that matches via a stronger transform is preferred over an
 * earlier call that only matches via a weaker one.
 *
 * This also lets `detectDeps` apply transform priority ACROSS multiple
 * consumed candidates for the same (call, location, field) key — e.g. a
 * request's raw "Bearer <token>" header value and its extracted token both
 * appear as separate consumed entries; without this, whichever one appears
 * first in the array could "steal" a weaker (e.g. substring) match before the
 * more specific exact-match candidate is ever tried.
 */
function findEarliestProducerForTransform(
  model: FlowModel,
  beforeCallIndex: number,
  value: string,
  transform: FlowDepTransform,
): Producer | undefined {
  for (const call of model.calls) {
    if (call.index >= beforeCallIndex) break;
    for (const produced of call.produced) {
      const match = matchValue(produced.value, value);
      if (match && match.transform === transform) {
        return {
          callIndex: call.index,
          source: produced.source,
          transform: match.transform,
          claimPath: match.claimPath,
          container: match.container,
        };
      }
    }
  }
  return undefined;
}

/** Extract the last dotted/colon segment of a produced source: "json:$.token" -> "token", "cookie:sid" -> "sid". */
function lastSegment(source: string): string {
  const colonIdx = source.indexOf(":");
  const rest = colonIdx === -1 ? source : source.slice(colonIdx + 1);
  const dotIdx = rest.lastIndexOf(".");
  const seg = dotIdx === -1 ? rest : rest.slice(dotIdx + 1);
  return seg.replace(/\[\d+\]$/, "");
}

/** Sanitize a raw segment into a valid identifier. */
function sanitizeIdentifier(raw: string): string {
  let id = raw.replace(/[^A-Za-z0-9_$]/g, "");
  if (!id) id = "value";
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return id;
}

/**
 * For each call (ascending), link each consumed value to an earlier call that
 * produced a related string (exact, url-encoded, base64, a JWT claim, or a
 * substring — see match.ts). At most one dep per (toCall, consumed
 * location+field).
 *
 * Producer selection is TRANSFORM-TIER-FIRST, THEN earliest-call-within-that-
 * tier — not strictly "earliest producer wins" across all transforms. For
 * each call, every not-yet-claimed key is tried against the "exact" tier
 * first (searching all its earlier calls, earliest first, across all of that
 * key's consumed candidates); only keys that find no exact producer fall
 * through to "urlenc", then "base64", then "jwt-claim", then "substring". So
 * a LATER call whose produced value relates via a stronger transform (e.g.
 * exact) is preferred over an EARLIER call that only relates via a weaker one
 * (e.g. substring) — see the cross-call test in deps.test.ts. Within a single
 * transform tier, the earliest call still wins, and a looser transform never
 * pre-empts a stronger one just because its consumed candidate happens to
 * appear earlier in the consumed array (see the Authorization-header test).
 * The same (fromCall, source) producer always reuses the same generated
 * varName.
 */
export function detectDeps(model: FlowModel): FlowDep[] {
  const deps: FlowDep[] = [];
  const claimedKeys = new Set<string>();
  const varNameByProducer = new Map<string, string>();
  const usedVarNames = new Set<string>();

  for (const call of model.calls) {
    for (const transform of TRANSFORM_PRIORITY) {
      for (const consumed of call.consumed) {
        const key = `${call.index}::${consumed.location}::${consumed.field}`;
        if (claimedKeys.has(key)) continue;

        const producer = findEarliestProducerForTransform(model, call.index, consumed.value, transform);
        if (!producer) continue;

        claimedKeys.add(key);

        const producerKey = `${producer.callIndex}::${producer.source}`;
        let varName = varNameByProducer.get(producerKey);
        if (!varName) {
          const base = sanitizeIdentifier(lastSegment(producer.source));
          varName = base;
          let suffix = 2;
          while (usedVarNames.has(varName)) {
            varName = `${base}${suffix}`;
            suffix++;
          }
          usedVarNames.add(varName);
          varNameByProducer.set(producerKey, varName);
        }

        deps.push({
          toCall: call.index,
          consumed,
          fromCall: producer.callIndex,
          source: producer.source,
          varName,
          transform: producer.transform,
          claimPath: producer.claimPath,
          container: producer.container,
        });
      }
    }
  }

  return deps;
}

/** Returns model with deps filled in from detectDeps. */
export function applyDeps(model: FlowModel): FlowModel {
  return { ...model, deps: detectDeps(model) };
}
