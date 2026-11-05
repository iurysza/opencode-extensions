import { createElement, insert, setProp, type JSX } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { controls, parse, scopeSchema, resultSchema, statusSchema, displayText, type Scope, type Inputs, type MethodName, type ControlResult } from "../control-contract.js";


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
    if (!lifetime.signal.aborted) ctx.ui.toast.show({ title: "Cloud", message: displayText(message), variant: error ? "warning" : "info" });
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
      return " Cloud: " + (!input.sessionID ? "select a session" : input.sessionID === status.sessionID ? status.text : "not loaded");
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
      await ctx.ui.dialog.alert({ title: "Cloud ledger", message: rows.length ? rows.map(row => displayText(row.id) + "  " + row.state).join("\n") : "No entries for this session" });
      return;
    }
    const id = await ctx.ui.dialog.select({ title: "Select entry to " + action, options: rows.map(row => ({ title: displayText(row.id), value: row.id, description: row.state })) });
    if (!id || !same(scope)) return;
    if (action === "followup") {
      const prompt = await ctx.ui.dialog.prompt({ title: "Cloud follow-up", description: "Send another task to this remote agent. Cloud billing applies." });
      if (prompt && await invoke("followup", { scope, id, prompt })) notify("Follow-up sent");
    }
    if ((action === "cancel" || action === "delete") && await ctx.ui.dialog.confirm({ title: action === "cancel" ? "Cancel Cloud agent?" : "Delete Cloud agent?", message: action + " " + displayText(id) + "? This operation may stop work or remove its record." })) {
      const result = action === "cancel" ? await invoke("cancel", { scope, id, confirmed: true }) : await invoke("delete", { scope, id, confirmed: true });
      if (result) notify(action === "cancel" ? "Agent cancelled" : "Agent deleted");
    }
  }
  async function cloud(input?: string) {
    await withScope(async scope => {
      const action = input?.trim() || await choose("Background Cloud", ["spawn", "list", "followup", "cancel", "delete"]);
      if (!action) return;
      if (action === "spawn" || action === "backgroundspawn") {
        const repository = await ctx.ui.dialog.prompt({ title: "GitHub repository", placeholder: "https://github.com/owner/repository" });
        if (!repository) return;
        const prompt = await ctx.ui.dialog.prompt({ title: "Background Cloud task", description: "Executes remotely and may incur Cloud charges. Do not include credentials." });
        if (!prompt) return;
        if (!await ctx.ui.dialog.confirm({ title: "Spawn background Cloud agent?", message: "Run this task remotely on " + displayText(repository) + "? Cloud billing applies." })) return;
        if (await invoke("spawn", { scope, repository, prompt, model: undefined })) notify("Background Cloud agent created");
      } else if (["list", "followup", "send", "cancel", "delete"].includes(action)) await list(scope, action === "send" ? "followup" : action);
      else notify("Use spawn, list, followup, cancel or delete", true);
    });
  }

  function command(name: string, run: (input?: string) => Promise<void>, keys?: string) {
    const proposed = keys ? "<leader>z c " + keys : undefined;
    // Host reserves <leader>c for compact. Keep Cursor categories below unused <leader>z c.
    // Avoid querying the reactive command registry while registering its own layer.
    return { id: controls.id + "." + name, title: "/" + name, group: "Cloud", palette: true as const,
      slash: { name, arguments: true as const }, bind: proposed ?? false as const,
      run: async (input?: string) => { try { if (!lifetime.signal.aborted) await run(input); } catch { notify("Control request failed; no success confirmed", true); } } };
  }
  // 2.0.0 keymap.layer requires a host component owner, not the detached setup root.
  const releaseCommands = ctx.ui.slot({ append: "app", render: () => {
    const commands = [command("cloud", cloud, "l"),
    { ...command("cloud-spawn", () => cloud("spawn"), "s"), slash: undefined },
    { ...command("cloud-followup", () => cloud("followup"), "f"), slash: undefined },
    { ...command("cloud-cancel", () => cloud("cancel"), "z c"), slash: undefined },
    { ...command("cloud-delete", () => cloud("delete"), "z d"), slash: undefined }];
    ctx.keymap.layer(() => ({ mode: "global", enabled: !lifetime.signal.aborted, commands }));
    return null;
  } });
  void refresh();
  return () => { lifetime.abort(); unsubscribe(); releaseSlot(); releaseCommands(); };
}
export const createTui = () => Plugin.define({ id: controls.id + ".tui", setup: createTuiControls });
export default createTui();
