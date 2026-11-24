// OpenCode 2.0.0 resolves a local plugin directory as ./server.js and does not
// read package.json exports. 2.2.5 uses the exports map and ignores this file.
// It is not part of the published tarball.
export { default } from "./dist/server.js";
export { createModelContextPlugin, PLUGIN_ID, DEFAULT_SKIP_PROVIDERS, HOOK_NAMES } from "./dist/server.js";
