import type { TraceBlock } from "../types";

const LABEL_RE = /^(Thought|Action|Action Input|Observation|Final Answer):\s*/gim;

/**
 * Split a stream chunk into (unlabeled preamble, labeled body).
 * The preamble is typically a `<think>…</think>` block; keeping it separate
 * prevents it from bleeding into a preceding observation on re-render.
 */
export function splitStepText(stepText: string): { preamble: string; body: string } {
  const re = /^(Thought|Action|Action Input|Observation|Final Answer):/im;
  const m = re.exec(stepText);
  if (!m) return { preamble: stepText, body: "" };
  return { preamble: stepText.slice(0, m.index), body: stepText.slice(m.index) };
}

/** Strip surrounding <think> tags and trim. */
export function normalizePreamble(text: string): string {
  return text.replace(/^\s*<think>/i, "").replace(/<\/think>\s*$/i, "").trim();
}

/**
 * Drop `<think>` reasoning from a user-facing answer, keeping only the reply.
 * Prefers the content after the last `</think>`; if that is empty, falls back
 * to the text with think blocks and any stray tags removed. This keeps a stray
 * `</think>` from ever leaking into the answer.
 */
export function stripThink(text: string): string {
  const closeIdx = text.lastIndexOf("</think>");
  if (closeIdx >= 0) {
    const tail = text.slice(closeIdx + "</think>".length).replace(/<\/?think>/gi, "").trim();
    if (tail) return tail;
  }
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
}

/** Parse the trace text (post-`splitStepText`) into typed blocks. */
export function parseTrace(text: string): TraceBlock[] {
  const clean = text.replace(/\r/g, "");
  const marks: Array<{ i: number; len: number; kind: string }> = [];
  LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LABEL_RE.exec(clean)) !== null) {
    marks.push({ i: m.index, len: m[0].length, kind: m[1]! });
  }
  const blocks: TraceBlock[] = [];
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i]!;
    const next = marks[i + 1];
    const start = cur.i + cur.len;
    const end = next ? next.i : clean.length;
    const body = clean.slice(start, end).replace(/\s+$/, "");
    blocks.push({
      kind: cur.kind.toLowerCase().replace(" ", "_") as TraceBlock["kind"],
      text: body,
    });
  }
  return blocks;
}

/**
 * Find the pending Action/Action-Input pair without a following Observation.
 */
export function extractPendingAction(
  blocks: TraceBlock[],
): { name: string; input: string } | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]!.kind !== "action_input") continue;
    for (let j = i + 1; j < blocks.length; j++) {
      if (blocks[j]!.kind === "observation") return null;
    }
    for (let j = i - 1; j >= 0; j--) {
      if (blocks[j]!.kind === "action") {
        return { name: blocks[j]!.text.trim(), input: blocks[i]!.text.trim() };
      }
    }
    return null;
  }
  return null;
}

export function extractFinal(blocks: TraceBlock[]): string | null {
  const found = [...blocks].reverse().find((b) => b.kind === "final_answer");
  return found ? stripThink(found.text) : null;
}
