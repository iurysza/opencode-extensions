import { describe, expect, it } from "vitest";
import { compactionToken, sameCompactionToken } from "../../src/compat/compaction-token.js";

const user = (id: string) => ({ type: "user", id });
const compaction = (id: string, status: "running" | "completed" | "failed") => ({ type: "compaction", id, status, reason: "auto" });

describe("compaction token", () => {
  it("is the no-compaction sentinel when no completed compaction exists", () => {
    expect(compactionToken([])).toEqual({ _tag: "ok", value: { _tag: "none" } });
    expect(compactionToken([user("msg_1"), compaction("msg_c1", "running")])).toEqual({ _tag: "ok", value: { _tag: "none" } });
    expect(compactionToken([compaction("msg_c1", "failed"), user("msg_2")])).toEqual({ _tag: "ok", value: { _tag: "none" } });
  });

  it("is the newest completed compaction id in history order", () => {
    const value = compactionToken([user("msg_1"), compaction("msg_c1", "completed"), user("msg_2"), compaction("msg_c2", "completed")]);
    expect(value).toEqual({ _tag: "ok", value: { _tag: "compaction", messageID: "msg_c2" } });
  });

  it("does not advance on a newer running or failed compaction", () => {
    const base = [user("msg_1"), compaction("msg_c1", "completed")];
    for (const status of ["running", "failed"] as const) {
      expect(compactionToken([...base, user("msg_2"), compaction("msg_c2", status)])).toEqual({ _tag: "ok", value: { _tag: "compaction", messageID: "msg_c1" } });
    }
  });

  it("ignores stored metadata such as keepID", () => {
    const row = { ...compaction("msg_c1", "completed"), metadata: { keepID: "msg_other" } };
    expect(compactionToken([row])).toEqual({ _tag: "ok", value: { _tag: "compaction", messageID: "msg_c1" } });
  });

  it("rejects malformed input", () => {
    for (const bad of [undefined, null, {}, "x", [null], [{ type: "compaction", status: "completed" }], [{ type: "compaction", id: "", status: "completed" }]]) {
      expect(compactionToken(bad)).toEqual({ _tag: "err", error: "malformed" });
    }
  });

  it("compares tokens by tag and id", () => {
    expect(sameCompactionToken({ _tag: "none" }, { _tag: "none" })).toBe(true);
    expect(sameCompactionToken({ _tag: "none" }, { _tag: "compaction", messageID: "a" })).toBe(false);
    expect(sameCompactionToken({ _tag: "compaction", messageID: "a" }, { _tag: "compaction", messageID: "a" })).toBe(true);
    expect(sameCompactionToken({ _tag: "compaction", messageID: "a" }, { _tag: "compaction", messageID: "b" })).toBe(false);
  });
});
