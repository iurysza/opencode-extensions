// Pure evidence checks for test/req/run-requests.mjs. TEST-ONLY. No I/O.
//
// Input: `steps`, one per CLI step in run order: `{ name, status, sessionID, entries }`, where
// `entries` are only the fixture log lines written while that step ran. Each entry is a
// `model.request` hook record or a `source` record from the fixture plugin.
//
// Correlation is an exact multiset match per step on the host's identity of a request:
// kind, sessionID, agent, model providerID, id and variant, all taken from the host hook event.
// Every source context must consume a distinct hook with the same identity in the same step,
// and every hook must be consumed. The decoded stamp is not trusted as the expected value.
export const KINDS = ["primary", "title", "compaction", "generate"];
export const FORGED_SESSION = "ses_forged";

const hookIdentity = (h) => ({
  kind: h.kind,
  sessionID: h.sessionID,
  agent: h.agent,
  model: { providerID: h.model?.providerID, id: h.model?.id, ...(h.model?.variant ? { variant: h.model.variant } : {}) },
});
const key = (c) => JSON.stringify([c?.kind, c?.sessionID, c?.agent, c?.model?.providerID, c?.model?.id, c?.model?.variant ?? null]);
const decode = (stamp) => {
  try {
    const { v, ...context } = JSON.parse(stamp ?? "null");
    return v === 1 ? context : null;
  } catch {
    return null;
  }
};

/** Pairs every source with a distinct hook of the same identity. Returns pairs and leftovers. */
export function matchStep(entries) {
  const hooks = entries.filter((e) => e.at === "model.request");
  const sources = entries.filter((e) => e.at === "source");
  const open = new Map();
  for (const h of hooks) {
    const k = key(hookIdentity(h));
    open.set(k, [...(open.get(k) ?? []), h]);
  }
  const pairs = [];
  const unmatchedSources = [];
  for (const s of sources) {
    const bucket = open.get(key(s.context));
    // The executing model must be the host's actual model, not merely the stamp's model.
    if (bucket?.length && s.modelId === bucket[0].model?.id) pairs.push({ hook: bucket.shift(), source: s });
    else unmatchedSources.push(s);
  }
  return { hooks, sources, pairs, unmatchedSources, unmatchedHooks: [...open.values()].flat() };
}

export function evaluate({ steps, sessionID, forkSessionID }) {
  const matched = steps.map((s) => ({ name: s.name, ...matchStep(s.entries) }));
  const all = (field) => matched.flatMap((m) => m[field]);
  const hooks = all("hooks");
  const sources = all("sources");
  const pairs = all("pairs");
  const byName = Object.fromEntries(matched.map((m) => [m.name, m]));
  const primaryIn = (name, session, modelId) =>
    (byName[name]?.pairs ?? []).some((p) => p.source.context.kind === "primary" && p.source.context.sessionID === session && (!modelId || p.source.modelId === modelId));
  const forkHooks = hooks.filter((h) => h.sessionID === forkSessionID);

  const checks = {
    primaryExit0: steps[0]?.status === 0,
    forgedStampOverwritten: hooks.length > 0 && hooks.every((h) => h.stamp && !h.stamp.includes(FORGED_SESSION)),
    // The plugin's stamp decodes to exactly the host's own hook fields.
    stampEqualsHookIdentity: hooks.length > 0 && hooks.every((h) => key(decode(h.stamp)) === key(hookIdentity(h))),
    noSourceSawForged: sources.every((s) => s.context?.sessionID !== FORGED_SESSION),
    everySourceMatchesHostHook: sources.length > 0 && matched.every((m) => m.unmatchedSources.length === 0),
    everyHookReachedSource: hooks.length > 0 && matched.every((m) => m.unmatchedHooks.length === 0),
    stableSessionAcrossTurns: Boolean(sessionID) && primaryIn("1-primary", sessionID) && primaryIn("2-autocompact", sessionID),
    forkIsSeparateSession: Boolean(forkSessionID) && forkSessionID !== sessionID,
    forkLineageAtRequestTime: forkHooks.length > 0 && forkHooks.every((h) => h.session?.fork?.sessionID === sessionID),
    modelChangeVisibleAtSource: Boolean(forkSessionID) && primaryIn("4-fork", forkSessionID, "fake") && primaryIn("5-model-change", forkSessionID, "fake2"),
  };
  const kinds = {};
  for (const kind of KINDS) {
    const kindPairs = pairs.filter((p) => p.source.context.kind === kind);
    kinds[kind] = { hookSeen: hooks.filter((h) => h.kind === kind).length, sourceSeen: sources.filter((s) => s.context?.kind === kind).length, matched: kindPairs.length };
    checks[`kind_${kind}_reachesDoStream`] = kindPairs.length > 0;
  }
  return { checks, kinds, pass: Object.values(checks).every(Boolean) };
}

/**
 * Negative regressions built from real captured evidence. Each mutation keeps record counts
 * unchanged or adds step-1 calls, and each must fail evaluation. Returns which ones failed.
 */
export function regressions(input) {
  const clone = () => structuredClone(input);
  const firstSource = (steps, pred) => steps.flatMap((s) => s.entries).find((e) => e.at === "source" && pred(e));
  const cases = {
    wrongHelperSession: () => {
      const x = clone();
      const s = firstSource(x.steps, (e) => e.context.kind !== "primary");
      if (s) s.context.sessionID = "ses_wrong_helper";
      return x;
    },
    wrongExecutingModel: () => {
      const x = clone();
      const s = firstSource(x.steps, () => true);
      if (s) s.modelId = "wrong-model";
      return x;
    },
    missingStep2Primary: () => {
      const x = clone();
      const two = x.steps.find((s) => s.name === "2-autocompact");
      const one = x.steps.find((s) => s.name === "1-primary");
      if (!two || !one) return x;
      const moved = two.entries.filter((e) => (e.at === "source" ? e.context.kind : e.kind) === "primary");
      two.entries = two.entries.filter((e) => !moved.includes(e));
      // Same total counts: a step-1 retry with identical identity cannot satisfy step 2.
      one.entries.push(...moved);
      return x;
    },
  };
  return Object.fromEntries(Object.entries(cases).map(([name, mutate]) => [name, { failsValidation: !evaluate(mutate()).pass }]));
}
