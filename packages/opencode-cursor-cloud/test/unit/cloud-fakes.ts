import type { Completion } from "../../src/core/cloud-client.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const finished: Completion = { type: "finished", result: { text: "remote result", durationMs: 25, branches: [{ repoUrl: "https://github.com/o/r", branch: "work", prUrl: "https://github.com/o/r/pull/1" }] } };
export async function until(test: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 100; n++) { if (await test()) return; await new Promise<void>(resolve => setImmediate(resolve)); }
  throw new Error("condition not reached");
}
