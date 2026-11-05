# Adversarial review: Phase 1 approval docs

> **Historical, superseded.** This review covered the OpenCode 1.18.33 plan. 1.x is now excluded. Its `parentID`-based delivery fix (R3) does not apply to 2.x, which has no `parentID`. See the [OpenCode 2.x boundary report](./research/opencode-v2-boundary.md) and the revised [plan](./plan.md). The text below is kept unchanged as evidence.

Scope: one pass over `README.md`, `readback.md`, `intent.md`, `plan.md`, `proposed-facts.md` and `feature-map.md`, checked against the four research reports. I spot-checked claims against `research/sources/opencode-v1.18.33` and `packages/pi-cursor-sdk/src`. I ran nothing and wrote only this file. This review is not exhaustive.

**Verdict: revise before approval.** The gate wording contradicts itself (R1). Two safety claims have no evidence behind them (R2, R4), and the G5 pass condition does not prove exactly-once delivery (R3). The rest is staleness and coverage.

## Required fixes

**R1. The "mock before real calls" wording contradicts G1 and G7.**
- The text: `README.md:7` ("G1 to G7 must pass with a mock SDK before any real Cursor call") and `plan.md:7,42` ("The spikes use no Cursor key and no network").
- The conflict: G1 (`plan.md:46`) imports the real SDK Bun build, opens a real `@cursor/sdk/sqlite` store and holds a bridge call for more than 60 s. That probe uses the actual SDK, not a mock. G7 (`plan.md:52`) needs a paid smoke test, which is not a mock either. F-57 (`proposed-facts.md:121`) says "mock plus runtime probe".
- The fix: define three tiers once and tag each gate with its tier.
  - (a) Mock tests: no SDK code runs.
  - (b) Offline probe of the actual SDK: real `@cursor/sdk` 1.0.37 under Bun, with no key and no network. It needs install approval after Phase 1.
  - (c) Live tests: paid, and each run needs its own approval (M7).
- Then: G1 is tier (b). G7 is (a) for release, with a (c) confirmation. Fix README:7 and plan:42 to match. State that the 60 s timeout check needs a local MCP stall, not Cursor's network.

**R2. A tool-less helper request does not mean Cursor native tools are disabled.**
- The text: G4 (`plan.md:49`), F-16 (`proposed-facts.md:46`), `readback.md:21`, `intent.md:26` ("no native side effects") and `feature-map.md:50`.
- The gap: "tool-less" removes OpenCode tools only. Cursor's agent loop still owns read, shell, edit and the rest. `pi-cursor-sdk.md:218,267` says it is unverified whether Cursor calls native tools during a summary turn, and no test covers it. `PI_CURSOR_REGISTER_NATIVE_TOOLS` and `PI_CURSOR_EXPOSE_BUILTIN_TOOLS` control display and bridge only (`src/cursor-native-tool-display-state.ts:10`, `src/cursor-pi-tool-bridge-env.ts:5`). They do not deny tools. "Fail closed if Cursor tries one" detects the side effect after it has already happened. It does not prevent it.
- The fix:
  - Reword F-16 and the readback so they promise no tool events and fail-closed detection, not "runs no native tools".
  - Add a G4 sub-question: does `@cursor/sdk` 1.0.37 have a proven mechanism that denies native tools, or a read-only mode? Verify it against the typings.
  - If no such mechanism exists, give Iury two bounded options: (i) route helper requests to a separately chosen non-Cursor model, accepting the parity gap, or (ii) accept the risk with sandbox on.
  - Never make the problem "pass" by suppressing UI events.

**R3. The G5 and F-58 confirmation signal is too weak.**
- The text: `plan.md:50` ("went busy, or a reply with `parentID` … re-post the same IDs, which upsert harmlessly"), F-58 (`proposed-facts.md:93`) and F-31 (`proposed-facts.md:92`).
- Source check:
  - The upsert is real. `core/src/session/projector.ts:262-271` has `onConflictDoUpdate` on `MessageTable.id`, and parts do the same at about line 320. That makes message storage idempotent. It does not make the turn unique.
  - "Session went busy" can come from any concurrent prompt, so it proves nothing about this message.
  - The loop exit at `opencode/src/session/prompt.ts:1111-1115` keys on `lastAssistant.parentID === lastUser.id`. A re-post that triggers a loop can therefore produce a second assistant reply when the first reply is already in flight.
- The fix: the only acceptance signal is a finished assistant message whose `parentID` equals the stored message ID. Before any re-post or nudge, the dispatcher queries for an existing reply with that `parentID`, so it posts or nudges only when none exists. Add a test where two replies race. Change F-31 so it covers duplicate assistant turns, not only duplicate completion messages. Take "upsert harmlessly" out of the pass condition.

**R4. Decision 4 claims an option without evidence.**
- The text: `plan.md:207` ("disabling Cursor native tools and routing everything through the bridge") and `intent.md:62`.
- The gap: no report shows that the SDK can disable native tools (same evidence as R2). The option may not exist.
- The fix: rewrite it as "OpenCode enforcement mandatory: feasibility unknown. It needs an SDK tool-denial mechanism (see the G4 sub-question). If none exists, the only path is a non-Cursor model, which drops parity." Keep the current recommendation.

**R5. The docs say research is pending, but it is finished.**
- The text: `README.md:24`, `readback.md:35`, `intent.md:86`, `plan.md:183` and `feature-map.md:3`. All say the reports are "still arriving".
- The fix: all four reports are final. Replace those lines with the gaps the reports actually list:
  - title-only tests (`pi-cursor-sdk.md:54-56,257-260`);
  - unread `cursor-session-agent-resume.ts:331-482` (`pi-cursor-sdk.md:308`);
  - unread `renderer-harness.ts` (`pi-cursor-cloud.md:42,284`);
  - whether Cursor bills for an agent created without a send (`sdk-cloud-settings.md:186`);
  - the `chain_user_input` coverage, which is unread (`pi-cursor-sdk.md:268`).
- Also label "Coverage incomplete" as known gaps, not pending work.

**R6. The SDK report has wrong internal pointers and overclaims full reads.**
- `research/pi-cursor-sdk.md:5` names the sibling as `pi-cursor-cloud.md`. It should be `sdk-cloud-settings.md`, since `pi-cursor-cloud.md` is the background package (`sdk-cloud-settings.md:3`).
- The heading "Read in full (source)" at `:20` lists partial ranges, for example `:29` reads "256–503; 1–255 in revision 1". `:41` carries revision-1 reads that were not re-read. Rename the heading to "Read (ranges noted)".
- `:241` says "Revision-1 list stands" and points to a revision that no longer exists as a file. Inline the list, or mark it unverifiable.
- `feature-map.md:5` cites this report for SDK features, so the wrong pointer misroutes readers.

**R7. A report recommendation was overridden, and the docs never say so.**
- `sdk-cloud-settings.md:9` (Conclusion 3) recommends porting the Cloud runtime as "a later, separable slice", with Phase 1 parity meaning settings and safety contracts only.
- The plan does the opposite. M3 is full parity (`plan.md:124`), and `feature-map.md:59` explicitly rejects a settings-only slice.
- That choice can be right, but it is unapproved scope until Iury picks it. Add it as a pending decision ("SDK Cloud runtime: full parity in M3, or a settings-only slice first"), or cite where Iury chose full parity.
- Keep these fixed regardless: the strict preflight (F-26), and Cloud as process-owned with no attach to absent agents (`intent.md:38`, `feature-map.md:23-25`). Neither needs changes.

**R8. The readback undersells the scope.**
- `readback.md:7-10` lists two things: local SDK models and background Cloud.
- The SDK foreground Cloud runtime is missing. That is M3, the largest milestone: the Git probe, the ledger and `/cursor-runtime`. It is the second product in `feature-map.md:22`.
- Iury approves the readback first, so it must name all three products. Add "3. SDK foreground Cloud runtime (opt-in): each turn runs on a fresh remote Cursor agent, with an acknowledgement, a strict Git preflight and a cleanup ledger."

**R9. The TUI adapter is framed as a proposal, but the docs contradict each other on whether TUI and backend share a process.**
- `plan.md:57` labels the adapter correctly. That is good.
- The conflict:
  - `opencode-api.md:229` infers that the backend and TUI share a process in a default local run. It recommends option (a), Cursor logic inside the TUI plugin.
  - The plan rejects (a) (`plan.md:61`) and assumes the two may be separate (`intent.md:50`). That is the safe choice.
- The fix: state in the plan that the plan departs from the report's recommendation, and why. The process topology of a default local run is unverified, so no code may assume a shared JavaScript singleton in either direction. G6 must test both topologies: default local and `attach`.
- Also note that no OpenCode documentation or source supports loopback discovery through `kv` or a file. It is entirely the lead's design.

**R10. The feature map has material gaps.**

These rows are missing from `feature-map.md` and have no facts behind them:
- The local commands `/cursor-fast`, `/cursor-mode agent|plan` (plan mode), `/cursor-tools`, `/cursor-http` (`PI_CURSOR_HTTP_1_1`), `/cursor-local-resume-cleanup` and `/cursor-refresh-config` (`sdk-cloud-settings.md:18`). Resume cleanup is destructive, with a durable intent before `Agent.delete` (`pi-cursor-sdk.md:203`). It needs a deterministic-path fact like F-28.
- The flag inventory: autoReview, sandbox, the one-shot local force, local resume on or off, and fast (`sdk-cloud-settings.md:44-50`). Each needs an OpenCode surface (provider option, env or command), or a stated drop.
- The model-list cache: a 0600 file, a 24 h TTL, a hashed key and a stale fallback (`pi-cursor-sdk.md:87-92`). F-04 is silent on the cache.
- Helper and compaction usage accounting. F-52 covers Cloud only. Decide whether helper usage is reported.
- Background Cloud's seven `/cloud` actions and Leader entries (`s l f o m z c z d`, `pi-cursor-cloud.md:181`). The map collapses them into one row at `:91`. List each action with its confirmation needs. Delete and cancel are destructive. `open` launches a browser.
- `cursor_cloud_completion` tidy specs and the `completionId` identity for chill (`pi-cursor-cloud.md:141,177`). Map these to the follow-up message metadata.

**R11. The "evidence is code reading" caveat must cover every "Yes" row.**

`feature-map.md:9` says this, which is good. Two rows still overclaim:
- `feature-map.md:65` marks the config resolver "Yes", but its tests are not ported or run.
- `:67` marks the preflight codes "Yes".

Mark both "Yes (portable, unverified)". The plan and README must keep saying that no test has run (`plan.md:3`, `README.md:3`), and that holds today.

## Smaller items

- `plan.md:168` maps F-58 to F-60 to "M4 and M5", but F-58 is the G5 dispatcher, so it belongs in M4. `M4.Facts` at `plan.md:140` omits F-58. Add it.
- `proposed-facts.md:74-75`: a blank line splits the SDK Cloud table, so F-46 to F-55 render as a separate headerless table. Remove the blank line.
- `intent.md:81` says G4 is "answered in principle". Keep that wording, but add the R2 caveat.

## Sources

- **Kept:** the four reports; `sources/opencode-v1.18.33/packages/opencode/src/session/prompt.ts:1100-1120,650-700`; `packages/core/src/session/projector.ts:262-325`; `packages/pi-cursor-sdk/src/cursor-native-tool-display-state.ts`, `cursor-pi-tool-bridge-env.ts`.
- **Dropped:** `sources/opencode-main`, because it is the 2.x target, which is out of scope.

## Gaps

- I did not check `@cursor/sdk` 1.0.37 typings for a tool-denial option, because `node_modules` is absent. That is the key question for R2 and R4. Next step: after install approval, grep the SDK `.d.ts` files for tool-policy or mode fields.
- I did not verify the TUI process topology for a default local run. Defer it to the G6 spike.

## Disposition

Recorded by the scribe after the lead's decisions. This is not a second independent review. Nothing was run.

| Finding | Disposition | Where |
|---|---|---|
| R1 | Resolved. Three proof tiers defined (T1 mock, T2 offline real SDK, T3 live). M0 allows loopback, not external network. Remote-only checks such as the 60 s timeout over Cursor's network move to T3. | `plan.md` Proof tiers, gate rows, F-57 |
| R2 | Resolved, partly superseded by new evidence. Published 1.0.37 declarations show local-only `tools: []` (text only), and that `tools` throws with `cloud` (`research/sdk-controls.md`). G4 is split into G4a (identification) and G4b (native-tool safety before execution). A proposed local `tools: []` helper lane needs a T2 probe and an approved T3 run. Otherwise a separately approved non-Cursor helper. Helpers never run on Cloud, and refuse to start without a lane. F-16 is an acceptance requirement, not a capability. | `plan.md` G4a, G4b, Proposed helper policy, F-16 |
| R3 | Resolved. Storage idempotence is not turn uniqueness. The dispatcher is per-session, accepts only `parentID`-correlated assistant evidence, checks finished and unfinished replies before any re-post, and keeps ambiguous states pending with a diagnostic. "Went busy" and "harmless upsert" are removed. Still proposed. Failure means replan with an upstream API. | `plan.md` G5, Proposed completion dispatcher, F-31, F-58 |
| R4 | Resolved, superseded by new evidence. Strict enforcement has a possible local path (`tools: ['mcp']`, no `task`), to be spiked. It loses native-agent parity and cannot cover Cloud, so it is not universally feasible. | `plan.md` decision 4, `feature-map.md` Permissions |
| R5 | Resolved. All reports are complete. Coverage is stated as end-to-end flows, not an exhaustive audit, with known gaps listed. | `README.md`, `plan.md` Known research gaps |
| R6 | Resolved. Sibling pointer fixed, heading renamed to "Read (ranges noted)", obsolete revision-1 list replaced with commit subjects and an explicit limitation, stale license gap updated. | `research/pi-cursor-sdk.md`, `research/sdk-cloud-settings.md` |
| R7 | Declined. Iury asked for both packages "as completely as Pi does today", and the SDK ships the foreground Cloud runtime today, so full M3 parity is already in scope. The settings-only suggestion is marked superseded. Phase 1 is study only. Decisions stay at five. | `intent.md` Scope basis, `plan.md` M3, `research/sdk-cloud-settings.md` |
| R8 | Resolved. The readback is shorter and names all three behaviors, including the foreground Cloud runtime. Recommendations moved to the plan. | `readback.md` |
| R9 | Resolved. The report's option (a) is marked rejected. Topology is unverified, so no shared singleton is assumed. G6 tests the default local run and `attach`. Token discovery is our design, not an OpenCode feature. | `plan.md` adapter, `research/opencode-api.md` §6 |
| R10 | Resolved. Added auth by surface, local commands and flags with OpenCode surfaces, model cache, usage by lane, the seven `/cloud` actions, Leader Key sequences, and the `completionId` versus folding gap. Pi asks no confirmation for `/cloud cancel` or `delete`, so any confirm is labelled a proposed addition. New facts F-61 to F-63. | `feature-map.md`, `proposed-facts.md` |
| R11 | Resolved. "Yes" now means static evidence only. Unported rows marked "Yes (portable, unverified)". Blank table row removed. F-58 mapped to M4. | `feature-map.md`, `proposed-facts.md`, `plan.md` coverage |
