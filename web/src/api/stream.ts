import type { ChatCompletionChunk } from "../types";

/** Parse a single SSE `data:` line. Returns null for keep-alives / [DONE]. */
export function parseSSELine(line: string): ChatCompletionChunk | null {
  const s = line.trim();
  if (!s.startsWith("data:")) return null;
  const payload = s.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as ChatCompletionChunk;
  } catch {
    return null;
  }
}

/**
 * Iterate `data:` events from a fetch Response body. Yields decoded content
 * deltas as strings; skips heartbeats and non-content chunks.
 */
export async function* readContentDeltas(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const chunk = parseSSELine(line);
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
