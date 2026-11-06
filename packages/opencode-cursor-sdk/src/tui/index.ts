import { createElement, insert, setProp, type JSX } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { controls, parse, scopeSchema, resultSchema, statusSchema, displayText, type Scope, type Inputs, type MethodName, type ControlResult } from "../control-contract.js";
import { REMOTE_ACK } from "../control-contract.js";
export const RUNTIME_DISCLOSURE = "Cloud runtime executes your prompts, code and tools on remote Cursor infrastructure and may incur subscription or usage charges. The selection persists for this OpenCode session until changed or cleared, including later turns and resumes. It does not change other sessions. Existing remote agents and their billing are not automatically stopped by switching back to local. Only continue if you authorize remote execution, billing and this persistent session scope.";

export function createTuiControls(ctx: Plugin.Context) {
  const rpc = ctx.client.rpc(controls);
  const lifetime = new AbortController();
  const [status, update] = ctx.storage.memory<{ sessionID: string; text: string }>(controls.id + ".status", { initial: { sessionID: "", text: "not loaded" } });
  function selected(): Scope | undefined {
    const route = ctx.ui.router.current();
    if (route.type !== "session") return undefined;
    try {
      const location = ctx.location ?? ctx.data.location.default();
      return parse(scopeSchema, { sessionID: route.sessionID, location: { directory: location.directory, workspaceID: location.workspaceID } });
    }
    catch { return undefined; }
  }
  function same(scope: Scope) {
    const current = selected();
    return current?.sessionID === scope.sessionID && current.location.directory === scope.location.directory &&
      current.location.workspaceID === scope.location.workspaceID;
  }
  const notify = (message: string, error = false) => {
    if (!lifetime.signal.aborted) ctx.ui.toast.show({ title: "Cursor", message: displayText(message), variant: error ? "warning" : "info" });
  };
  async function invoke<K extends MethodName>(name: K, input: Inputs[K], quiet = false): Promise<ControlResult | undefined> {
    if (lifetime.signal.aborted) return undefined;
    if (!same(input.scope) || input.scope.location.workspaceID) { notify("Session changed or remote workspace refused", true); return undefined; }
    try {
      parse(controls.methods[name].input, input);
      // The name and parsed input come from the same fixed contract. Reflect preserves this
      // relationship across the heterogeneous method table; the reply is independently parsed.
      const reply: unknown = await Reflect.apply(rpc[name], rpc, [input, { location: input.scope.location, signal: lifetime.signal }]);
      const result = parse(resultSchema, reply);
      if (!same(input.scope) || lifetime.signal.aborted) return undefined;
      if (name === "status" || result.code !== "ok") update(draft => { draft.sessionID = input.scope.sessionID; draft.text = result.code === "ok" ? (result.snapshot?.state ?? result.snapshot?.runtime ?? "ready") : result.code.replaceAll("_", " "); });
      if (result.code !== "ok") { if (!quiet) notify(result.code.replaceAll("_", " "), true); return undefined; }
      return result;
    } catch { if (!quiet) notify("Control request failed; no success confirmed", true); return undefined; }
  }
  async function refresh() { const scope = selected(); if (scope) await invoke("status", { scope }, true); }
  const unsubscribe = rpc.events.on("status", event => {
    try { const data = parse(statusSchema, event.data); if (same(data.scope)) void refresh(); }
    catch { /* Ignore malformed or unrelated events, never render them. */ }
  }, { signal: lifetime.signal });
  const releaseSlot = ctx.ui.slot({ append: "prompt.footer.status", render: input => {
    // Public shared renderer only. Plain strings are orphan nodes under the host footer box.
    const node = createElement("text");
    setProp(node, "wrapMode", "none");
    setProp(node, "flexShrink", 0);
    let requested = "";
    insert(node, () => {
      if (input.sessionID && requested !== input.sessionID) { requested = input.sessionID; void refresh(); }
      return " Cursor: " + (!input.sessionID ? "select a session" : input.sessionID === status.sessionID ? status.text : "not loaded");
    });
    // OpenTUI's native factory returns BaseRenderable while JSX aliases Solid's DOM Element.
    // The shared native renderer accepts this exact node, proven on both supported endpoints.
    return node as unknown as JSX.Element;
  } });
  async function choose<const T extends string>(title: string, values: readonly T[]): Promise<T | undefined> {
    return ctx.ui.dialog.select({ title, options: values.map(value => ({ title: value, value })) });
  }
  async function withScope(run: (scope: Scope) => Promise<void>) {
    const scope = selected();
    if (!scope || scope.location.workspaceID) { notify("Select a local session; remote workspaces are disabled", true); return; }
    await run(scope);
  }
  async function list(scope: Scope, action: string) {
    const result = await invoke("ledger", { scope });
    if (!result) return;
    const rows = result.snapshot?.items ?? [];
    if (action === "list") {
      await ctx.ui.dialog.alert({ title: "Cursor ledger", message: rows.length ? rows.map(row => displayText(row.id) + "  " + row.state).join("\n") : "No entries for this session" });
      return;
    }
    const id = await ctx.ui.dialog.select({ title: "Select entry to " + action, options: rows.map(row => ({ title: displayText(row.id), value: row.id, description: row.state })) });
    if (!id || !same(scope)) return;
    if (action === "archive" && await ctx.ui.dialog.confirm({ title: "Archive foreground Cloud entry?", message: "Archive " + displayText(id) + "? This detaches local ownership of the persistent remote agent." })) {
      if (await invoke("archive", { scope, id, confirmed: true })) notify("Entry archived");
    }
    if (action === "delete" && await ctx.ui.dialog.confirm({ title: "Delete foreground Cloud entry?", message: "Delete " + displayText(id) + "? This cannot be undone." })) {
      if (await invoke("delete", { scope, id, confirmed: true })) notify("Entry deleted");
    }
  }
  async function foreground(input?: string) {
    await withScope(async scope => {
      const action = input?.trim() || await choose("Foreground Cloud ledger", ["list", "archive", "delete"]);
      if (action && ["list", "archive", "delete"].includes(action)) await list(scope, action);
      else if (action) notify("Use list, archive or delete", true);
    });
  }
  async function runtime(input?: string) {
    await withScope(async scope => {
      const runtime = input?.trim() || await choose("Cursor runtime", ["local", "cloud"]);
      if (runtime !== "local" && runtime !== "cloud") return;
      if (runtime === "cloud" && !await ctx.ui.dialog.confirm({ title: "Enable foreground Cloud runtime?", message: RUNTIME_DISCLOSURE, label: { confirm: "Acknowledge and enable", cancel: "Keep current runtime" } })) return;
      if (await invoke("runtime", { scope, runtime, acknowledgement: runtime === "cloud" ? REMOTE_ACK : undefined })) notify("Runtime updated for this session");
    });
  }
  async function setting(name: "fast" | "mode" | "tools" | "http" | "resumeCleanup", input?: string) {
    await withScope(async scope => {
      const choices = name === "mode" ? ["agent", "plan"] : name === "tools" ? ["native", "bridge", "both"] : name === "http" ? ["auto", "http1"] : ["on", "off"];
      const value = input?.trim() || await choose("Cursor " + name, choices);
      if (!value || !choices.includes(value)) return;
      const result = name === "mode" ? await invoke("mode", { scope, mode: value as "agent" | "plan" })
        : name === "tools" ? await invoke("tools", { scope, tools: value as "native" | "bridge" | "both" })
        : name === "http" ? await invoke("http", { scope, http: value as "auto" | "http1" })
        : name === "fast" ? await invoke("fast", { scope, enabled: value === "on" })
        : await invoke("resumeCleanup", { scope, enabled: value === "on" });
      if (result) notify("Setting updated for this session");
    });
  }
  async function reload(name: "refreshModels" | "refreshConfig") {
    await withScope(async scope => { if (await invoke(name, { scope })) notify("Refresh completed"); });
  }

  function command(name: string, run: (input?: string) => Promise<void>, keys?: string) {
    const proposed = keys ? "<leader>z c " + keys : undefined;
    // Host reserves <leader>c for compact. Keep Cursor categories below unused <leader>z c.
    // Avoid querying the reactive command registry while registering its own layer.
    return { id: controls.id + "." + name, title: "/" + name, group: "Cursor", palette: true as const,
      slash: { name, arguments: true as const }, bind: proposed ?? false as const,
      run: async (input?: string) => { try { if (!lifetime.signal.aborted) await run(input); } catch { notify("Control request failed; no success confirmed", true); } } };
  }
  // 2.0.0 keymap.layer requires a host component owner, not the detached setup root.
  const releaseCommands = ctx.ui.slot({ append: "app", render: () => {
    const commands = [command("cursor-cloud", foreground, "z h"),
    command("cursor-runtime", runtime),
    { ...command("cursor-runtime-local", () => runtime("local"), "r l"), slash: undefined },
    { ...command("cursor-runtime-cloud", () => runtime("cloud"), "r c"), slash: undefined }, command("cursor-fast", input => setting("fast", input), "q"),
    command("cursor-mode", input => setting("mode", input)),
    { ...command("cursor-mode-plan", () => setting("mode", "plan"), "p"), slash: undefined },
    { ...command("cursor-mode-agent", () => setting("mode", "agent"), "a"), slash: undefined }, command("cursor-tools", input => setting("tools", input), "z x t"),
    command("cursor-http", input => setting("http", input), "z x h"), command("cursor-local-resume-cleanup", input => setting("resumeCleanup", input), "z x r"),
    command("cursor-refresh-models", () => reload("refreshModels"), "z x m"), command("cursor-refresh-config", () => reload("refreshConfig"), "z x c")];
    ctx.keymap.layer(() => ({ mode: "global", enabled: !lifetime.signal.aborted, commands }));
    return null;
  } });
  void refresh();
  return () => { lifetime.abort(); unsubscribe(); releaseSlot(); releaseCommands(); };
}
export const createTui = () => Plugin.define({ id: controls.id + ".tui", setup: createTuiControls });
export default createTui();
