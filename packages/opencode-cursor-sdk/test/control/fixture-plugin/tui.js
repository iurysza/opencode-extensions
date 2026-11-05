// Actual host context and native renderer. Only command observation is added here.
import { appendFileSync } from "node:fs";
import sdk from "../../../../../.fixtures/control-build/sdk/tui.js";
import cloud from "../../../../../.fixtures/control-build/cloud/tui.js";
export default { id: "cursor-controls-fixture-tui", setup(original) {
  const log = record => { if (process.env.CONTROL_TUI_LOG) appendFileSync(process.env.CONTROL_TUI_LOG, JSON.stringify(record) + "\n"); };
  const ctx = { ...original, get location() { return original.location; }, keymap: { ...original.keymap, layer(factory) {
    original.keymap.layer(() => {
      const layer = factory();
      return { ...layer, commands: layer.commands?.map(command => ({ ...command, run(input) {
        log({ at: "command", id: command.id }); return command.run(input);
      } })) };
    });
  } } };
  const releaseSdk = sdk.setup(ctx);
  const releaseCloud = cloud.setup(ctx);
  return async () => { (await releaseSdk)?.(); (await releaseCloud)?.(); };
} };
