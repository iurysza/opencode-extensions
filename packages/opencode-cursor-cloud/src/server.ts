import { createCloudPlugin } from "./plugin/create.js";

export { createCloudPlugin, PLUGIN_ID } from "./plugin/create.js";
export { createCloudService } from "./core/cloud-service.js";
export type { CloudService, CloudResponse, CloudReply, SpawnParams } from "./core/cloud-service.js";

// Constructing the definition performs no SDK import, credential lookup, Git call or network I/O.
export default createCloudPlugin();
