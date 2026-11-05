# Remaining port work

This checkpoint accompanies the switch to lnx1. It does not change the accepted facts or authorize live calls.

## Current slice

Mode/tool controls and trusted local-setting mapping are implemented in `cursor-port`, pending lead checks and commit before branching for Linux. The frozen `ed754c2` macOS alpha is under `.fixtures/home-alpha-ed754c2`; its dependency tree is an independent copy-on-write clone.

## Helper safety: G4b

Production helpers remain disabled. Public SDK 1.0.37 types support local `tools: []`; keyless creation is qualified, but no send has run. Neither T1 fakes nor keyless initialization proves native-tool denial. The approved contract requires T2 and separately approved T3 evidence before enabling the lane.

A future helper implementation should create a fresh agent/store per request, pass only the supplied helper prompt and explicit `tools: []`, and never copy coding/Cloud options, MCP, custom tools, tasks or pooled history. Abort, unexpected tool events and consumer cancellation must cancel and dispose it. No activation switch should bypass qualification.

## Durable resume: F-22 to F-24, F-63 and G3

SQLite durability alone is not ownership authority. Extend the local port with agent identity and public resume/delete operations, using public host storage for versioned ownership records. Bind session, cwd/location, model/options pool key, fork boundary, exact store identity and persisted compaction generation. Invalidate before uncertain sends and publish resumability only after a proven successful history boundary. Separate orderly shutdown from reset. Cleanup requires explicit confirmation, recorded `agent-*` IDs and durable intent/result records; never list global SDK agents to discover candidates.

The current `compactionToken` is a completed-compaction observation, not a durable resume record or generation. Production already incorporates it in the in-memory reuse signature. G3 still needs real-host fork/model/compaction and replay qualification across the `providerState`/`native` split.

## Cross-turn bridge qualification

Parent review initially suspected a stale bridge URL from pooled-agent creation. Full source inspection corrected that: the existing send path already supplies the fresh `mcpServers` override on every send, and public SDK `SendOptions` supports it. No stale-URL defect has been established. Same-run continuation cases already pass. A fake-SDK regression in `test/unit/local-runtime.test.ts` now proves the runtime side: two user turns reuse one pooled agent, turn 1's bridge is closed before turn 2, turn 2's send carries only its fresh bridge URL (never turn 1's), and native-only turns pass no `mcpServers` at create or send. It does not prove the real SDK honours a per-send `mcpServers` override on a pooled agent; that stays unqualified until an approved live probe. Do not change the design to fix an unproven bug.

## Remaining controls and catalog

Fast must use the advertised model `fast` parameter and refuse unsupported models. Persistent model metadata must satisfy F-62: key hash, 0600 permissions, 24-hour default TTL and whole-file validation. HTTP/1 selection remains unavailable: the public SDK override is process-global, so a per-session toggle cannot silently change other sessions. Resume cleanup is destructive, not an on/off setting.

## Release and live gates

The release plan matches the built release-please automation. Root and children remain private, automation remains disabled and the chosen remote is not created. Cursor terms review, live SDK transport, helper denial and Cloud requalification still need the approved release/live gates. No prompt, real resume, Cloud agent or credential lookup is authorized by the Linux brief.
