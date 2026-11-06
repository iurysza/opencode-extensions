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
  Object.assign(checks, compactionChecks(steps, sessionID, forkSessionID));
  const kinds = {};
  for (const kind of KINDS) {
    const kindPairs = pairs.filter((p) => p.source.context.kind === kind);
    kinds[kind] = { hookSeen: hooks.filter((h) => h.kind === kind).length, sourceSeen: sources.filter((s) => s.context?.kind === kind).length, matched: kindPairs.length };
    checks[`kind_${kind}_reachesDoStream`] = kindPairs.length > 0;
  }
  return { checks, kinds, pass: Object.values(checks).every(Boolean) };
}

const tokenKey = (t) => (t && !t.error ? JSON.stringify(t) : null);
const NONE = JSON.stringify({ _tag: "none" });

/**
 * G3 prerequisite: the durable compaction token read through public `session.context` at
 * request time. In each session, the token may change only right after a compaction request.
 * Host shape differs: 2.0.0-2.0.4 and 2.2.x show the in-flight compaction as a `running` row
 * during the compaction request; 2.0.20-2.1.0 show no row until it completes. When a running
 * row is visible, the new token must equal its id and the running row must not be the token.
 * When none is visible, the new token must be an id never seen in earlier requests. The token
 * must survive a separate CLI process.
 */
export function compactionChecks(steps, sessionID, forkSessionID) {
  const hooks = steps.flatMap((s) => s.entries.filter((e) => e.at === "model.request").map((h) => ({ ...h, step: s.name })));
  const ofSession = (id) => hooks.filter((h) => h.sessionID === id);
  const tokenAt = (step, kind, id) => tokenKey(hooks.find((h) => h.step === step && h.kind === kind && h.sessionID === id)?.compaction?.token);
  const runningIds = (h) => (h.compaction?.rows ?? []).filter((r) => r.status === "running").map((r) => r.id);
  const transitionsValid = (list) => {
    let changes = 0;
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = tokenKey(list[i].compaction?.token);
      if (cur === tokenKey(prev.compaction?.token)) continue;
      changes++;
      if (prev.kind !== "compaction" || cur === null) return -1;
      const running = runningIds(prev);
      if (running.length > 1) return -1;
      if (running.length === 1 && cur !== JSON.stringify({ _tag: "compaction", messageID: running[0] })) return -1;
      if (running.length === 0 && list.slice(0, i).some((h) => (h.compaction?.rows ?? []).some((r) => JSON.stringify({ _tag: "compaction", messageID: r.id }) === cur))) return -1;
    }
    return changes;
  };
  const main = ofSession(sessionID);
  const fork = ofSession(forkSessionID);
  const step2Token = tokenAt("2-autocompact", "primary", sessionID);
  return {
    compactionTokenReadable: hooks.length > 0 && hooks.every((h) => tokenKey(h.compaction?.token) !== null),
    compactionTokenNoneBeforeCompaction: Boolean(sessionID) && tokenAt("1-primary", "primary", sessionID) === NONE && tokenAt("2-autocompact", "compaction", sessionID) === NONE,
    runningCompactionDoesNotAdvanceToken: hooks.filter((h) => h.kind === "compaction").every((h) => runningIds(h).every((id) => tokenKey(h.compaction.token) !== JSON.stringify({ _tag: "compaction", messageID: id }))),
    compactionTokenChangesAfterAutoCompaction: transitionsValid(main) === 1 && step2Token !== NONE && step2Token !== null,
    compactionTokenSurvivesProcessRestart: step2Token !== null && tokenAt("3-generate", "generate", sessionID) === step2Token,
    forkCompactionTokenOwnLineage: fork.length > 0 && transitionsValid(fork) >= 1 && fork.every((h) => tokenKey(h.compaction?.token) !== step2Token),
  };
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
    // Token reset after restart (e.g. a per-process counter) must fail.
    compactionTokenLostOnRestart: () => {
      const x = clone();
      const h = x.steps.find((s) => s.name === "3-generate")?.entries.find((e) => e.at === "model.request");
      if (h?.compaction) h.compaction.token = { _tag: "none" };
      return x;
    },
    // A running row advancing the token must fail.
    runningCompactionAdvancesToken: () => {
      const x = clone();
      const h = x.steps.find((s) => s.name === "2-autocompact")?.entries.find((e) => e.at === "model.request" && e.kind === "compaction");
      const running = h?.compaction?.rows?.find((r) => r.status === "running");
      if (running) h.compaction.token = { _tag: "compaction", messageID: running.id };
      return x;
    },
    // After a compaction, a token that reverts to an earlier compaction id must fail.
    compactionTokenRevertsToStale: () => {
      const x = clone();
      const hooks = x.steps.flatMap((s) => s.entries).filter((e) => e.at === "model.request" && e.sessionID === x.forkSessionID);
      const stale = hooks[0]?.compaction?.rows?.[0]?.id;
      const last = hooks.at(-1);
      if (stale && last?.compaction) last.compaction.token = { _tag: "compaction", messageID: stale };
      return x;
    },
    // A token that changes without a preceding compaction request must fail.
    compactionTokenChangesWithoutCompaction: () => {
      const x = clone();
      const h = x.steps.find((s) => s.name === "1-primary")?.entries.find((e) => e.at === "model.request" && e.kind === "primary");
      if (h?.compaction) h.compaction.token = { _tag: "compaction", messageID: "msg_invented" };
      return x;
    },
  };
  // Only applicable when the host shows a running row during a compaction request.
  const applicable = { runningCompactionAdvancesToken: runningRowVisible(input.steps) };
  return Object.fromEntries(
    Object.entries(cases).map(([name, mutate]) => [name, { applicable: applicable[name] ?? true, failsValidation: !evaluate(mutate()).pass }]),
  );
}

/** Whether any compaction request saw its in-flight compaction as a `running` row. */
export function runningRowVisible(steps) {
  return steps.some((s) => s.entries.some((e) => e.at === "model.request" && e.kind === "compaction" && (e.compaction?.rows ?? []).some((r) => r.status === "running")));
}
