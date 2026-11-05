# G5: completion acknowledgment limits

Status: source evidence, not a runtime gate result. **Decision approved** by Iury through Plannotator Inbox message `msg_redacted`: "Revise G5 to deduplicated notifications, conservative recovery and explicit unknown answer status, but be pragmatic". F-31 and F-58 and the plan's G5 wording were amended accordingly. The original status text follows as history.

Original status: source evidence, not a runtime gate result. Accepted facts are unchanged. This finding blocks completion-delivery implementation pending a contract decision; the bounded provider-loading harness can continue.

## Finding

The proposed receipt design can deduplicate notifications. We cannot currently justify its stronger guarantee that process restart never causes another assistant response, or reliably identify an answered receipt across arbitrary providers and compaction.

The first investigated approach stamps receipt IDs into the Cursor provider's finish metadata. It does not cover the independently installable background Cloud package when another provider answers. It must not become an undocumented dependency on the Cursor SDK provider.

## Evidence

Source revisions: OpenCode v2.0.0 `63f7ceecbed2d7d9a627518d935dd963b9d4ac9f` and v2.2.5 `9bbb8ce18c80f099e0e448775f59d965ead40a21`.

- The public context hook exposes session, model, messages and options, but no attempt or assistant-message identity: `packages/plugin/src/promise/session.ts`, v2.0.0 lines 25–36. The model-request hook also lacks that identity (lines 63–70).
- The runner allocates an assistant ID before invoking the hooks, but does not expose it in their payloads: `packages/core/src/session/runner/llm.ts`, v2.0.0 lines 201–265. Joining a hook invocation to a later event by time or message order is not causal proof.
- A provider can attach finish metadata; the host projects it to `providerState` at v2.0.0 (`packages/core/src/session/message-updater.ts`, lines 243–259) and `native` at v2.2.5 (lines 265–281). A different provider does not automatically emit our stamps. A failed terminal message is not a successful answer.
- `session.context` returns only history from the latest completed compaction onward: `packages/core/src/session/store.ts`, v2.0.0 line 179; `history.ts`, lines 28–58 and 83–93. Older assistant stamps can disappear from that public read. At v2.2.5, see `store.ts:194` and `history.ts:192–200`.
- The backend plugin context at both tags has no general client or message-history domain: `packages/plugin/src/promise/plugin.ts`. The session domain exposes `context`, not `message.list` or session export. The existence of separate client endpoints is not proof that the plugin has an authenticated route to them.
- Host recovery explicitly says: “Recovery is at-least-once: local coordination prevents concurrent drains, not repeated external side effects after a crash.” See `packages/core/src/session/execution/restart.ts`, v2.0.0 lines 46–62. It inserts a restart-continuation input at lines 92–96. A plugin receipt does not change that host recovery policy.

These findings do not show that a specific runtime test has duplicated a response. They show that the proposed proof and guarantee need revision or stronger host support. In particular, a later request containing an old receipt in its history is not proof of the original completion's answer.

## Decision needed

Either keep the stronger guarantee and block this feature while seeking a supported solution, or explicitly narrow it to plugin-controlled notification delivery:

- One durable receipt and stable notification ID per observed completion.
- Reject changed payloads and never intentionally resubmit an already promoted notification.
- Preserve unresolved admission and acknowledgment states; never replay blindly.
- Report delivery separately from answer status. Use “unknown” without direct correlation evidence, including after compaction or with another provider.
- Disclose that OpenCode may rerun interrupted model work after restart. Do not claim exactly-once assistant execution.

The latter changes F-31 and the G5 acceptance wording. F-30 and F-58 must be checked for consistency rather than silently weakened. Neither option is authorized by this note.
