/*!
 * Host-identical `msg_` message ID generator.
 *
 * Adapted from OpenCode `packages/schema/src/identifier.ts` (`ascending`) and
 * `packages/schema/src/session-message.ts` (`SessionMessage.ID.create`), identical at
 * v2.0.0 (63f7ceec) and v2.2.5 (9bbb8ce1). Copied rather than imported: production code may
 * only import public `@opencode/plugin`. The upstream notice below applies to this file.
 *
 * MIT License
 *
 * Copyright (c) 2025 opencode
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Shape: "msg_" + 12 hex chars of (timestamp * 0x1000 + counter), big-endian 48 bits, then 14
// base62 random chars. The clock and random source are injected so the generator is testable.

const LENGTH = 26;
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export interface IdSource {
  readonly now: () => number;
  readonly random: (bytes: number) => Uint8Array;
}

export const systemIdSource: IdSource = {
  now: () => Date.now(),
  random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
};

/** Ascending ID factory with the host's per-millisecond counter. Never derives from remote IDs. */
export function messageIdFactory(source: IdSource = systemIdSource): () => string {
  let lastTimestamp = 0;
  let counter = 0;
  return () => {
    const timestamp = source.now();
    if (timestamp !== lastTimestamp) {
      lastTimestamp = timestamp;
      counter = 0;
    }
    counter++;
    const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
    const time = Array.from({ length: 6 }, (_, index) =>
      Number((current >> BigInt(40 - 8 * index)) & 0xffn)
        .toString(16)
        .padStart(2, "0"),
    ).join("");
    const bytes = source.random(LENGTH - 12);
    return `msg_${time}${Array.from(bytes, (byte) => CHARS[byte % 62]).join("")}`;
  };
}

/** Shape check for IDs we minted: the host schema only requires the `msg_` prefix. */
export const isMintedMessageId = (value: unknown): value is string =>
  typeof value === "string" && /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(value);
