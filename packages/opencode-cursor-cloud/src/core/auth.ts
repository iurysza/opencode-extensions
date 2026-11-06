/** No filesystem access. Host key wins; an invalid active credential fails closed. */
export interface CloudAuth {
  readonly hostCredential: () => Promise<unknown>;
  readonly envKey: () => string | undefined;
}

export function cloudKey(auth: CloudAuth): () => Promise<string> {
  return async () => {
    let credential: unknown;
    try { credential = await auth.hostCredential(); }
    catch { throw new Error("Cursor Cloud host authentication lookup failed."); }
    if (credential !== undefined && credential !== null) {
      if (typeof credential === "object" && "type" in credential && credential.type === "key" &&
          "key" in credential && typeof credential.key === "string" && credential.key.trim()) return credential.key.trim();
      throw new Error("Cursor Cloud needs a key credential for the cursor integration.");
    }
    const env = auth.envKey()?.trim();
    if (env) return env;
    throw new Error("Cursor Cloud needs a host cursor key or CURSOR_API_KEY.");
  };
}
