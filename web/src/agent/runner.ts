import { AGENT_MAX_STEPS, AGENT_STEP_TOKENS } from "../config";
import { streamChat } from "../api/openai";
import type { MemoryMatch } from "../memory/types";
import type { RagMatch } from "../rag/types";
import type { SkillMatch } from "../skills/types";
import type { ChatMessage } from "../types";
import type { ToolDefinition } from "./tools";
import { buildReactSystemPrompt } from "./prompt";
import {
  extractFinal,
  extractPendingAction,
  normalizePreamble,
  parseTrace,
  splitStepText,
  stripThink,
} from "./parser";

export type AgentEvent =
  | {
      type: "context";
      memories: MemoryMatch[];
      ragMatches: RagMatch[];
      skills: SkillMatch[];
      tools: string[];
    }
  | { type: "step-start"; step: number }
  | { type: "stream"; step: number; trace: string; preambles: PreambleEntry[] }
  | { type: "step-end"; step: number; trace: string; preambles: PreambleEntry[] }
  | { type: "observation"; step: number; trace: string; preambles: PreambleEntry[]; html?: string }
  | { type: "metrics"; metrics: AgentRunMetrics }
  | { type: "final"; answer: string }
  | { type: "error"; message: string; aborted?: boolean }
  | { type: "max-steps" };

export type PreambleEntry = { afterBlockIdx: number; text: string };

export type AgentRunMetrics = {
  steps: number;
  toolCalls: number;
  outputChars: number;
  estimatedOutputTokens: number;
  elapsedMs: number;
  modelMs: number;
  toolMs: number;
  estimatedTokensPerSecond: number;
};

export type RunAgentArgs = {
  baseUrl: string;
  model: string;
  goal: string;
  tools: Record<string, ToolDefinition>;
  memories: MemoryMatch[];
  ragMatches: RagMatch[];
  skills: SkillMatch[];
  memoryPrompt: string;
  ragPrompt: string;
  skillPrompt: string;
  rolePrompt?: string;
  maxSteps?: number;
  signal: AbortSignal;
  onEvent: (e: AgentEvent) => void;
};

export async function runAgent(a: RunAgentArgs): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildReactSystemPrompt(a.tools, {
        memory: a.memoryPrompt,
        rag: a.ragPrompt,
        skills: a.skillPrompt,
        role: a.rolePrompt,
      }),
    },
    { role: "user", content: a.goal },
  ];
  let trace = "";
  const preambles: PreambleEntry[] = [];
  const toolCalls = new Set<string>();
  let networkFailures = 0;
  let networkDisabled = false;
  let duplicateBlocks = 0;
  const startedAt = performance.now();
  let steps = 0;
  let toolCallCount = 0;
  let outputChars = 0;
  let modelMs = 0;
  let toolMs = 0;
  const metrics = (): AgentRunMetrics => {
    const estimatedOutputTokens = Math.ceil(outputChars / 4);
    return {
      steps,
      toolCalls: toolCallCount,
      outputChars,
      estimatedOutputTokens,
      elapsedMs: performance.now() - startedAt,
      modelMs,
      toolMs,
      estimatedTokensPerSecond: modelMs
        ? estimatedOutputTokens / (modelMs / 1000)
        : 0,
    };
  };
  const emitMetrics = () => a.onEvent({ type: "metrics", metrics: metrics() });
  a.onEvent({
    type: "context",
    memories: a.memories,
    ragMatches: a.ragMatches,
    skills: a.skills,
    tools: Object.keys(a.tools),
  });

  const maxSteps = Math.min(20, Math.max(1, a.maxSteps ?? AGENT_MAX_STEPS));
  for (let step = 0; step < maxSteps; step++) {
    steps = step + 1;
    a.onEvent({ type: "step-start", step });

    const stepMessages = [...messages];
    if (trace) stepMessages.push({ role: "assistant", content: trace });

    let stepText: string;
    const modelStartedAt = performance.now();
    try {
      stepText = await streamChat(a.baseUrl, {
        model: a.model,
        messages: stepMessages,
        maxTokens: AGENT_STEP_TOKENS,
        stop: ["\nObservation:", "Observation:"],
        signal: a.signal,
        onDelta: (_d, cur) => {
          a.onEvent({ type: "stream", step, trace: trace + cur, preambles });
        },
      });
    } catch (err) {
      modelMs += performance.now() - modelStartedAt;
      emitMetrics();
      const e = err as Error;
      const aborted = e.name === "AbortError";
      a.onEvent({ type: "error", message: aborted ? "已停止" : e.message, aborted });
      return null;
    }
    modelMs += performance.now() - modelStartedAt;
    outputChars += stepText.length;

    const { preamble, body } = splitStepText(stepText);
    const cleaned = normalizePreamble(preamble);
    if (cleaned) preambles.push({ afterBlockIdx: parseTrace(trace).length, text: cleaned });

    trace += body;
    a.onEvent({ type: "step-end", step, trace, preambles });
    emitMetrics();

    const blocks = parseTrace(trace);
    const finalAns = extractFinal(blocks);
    if (finalAns) {
      emitMetrics();
      a.onEvent({ type: "final", answer: finalAns });
      return finalAns;
    }

    const pending = extractPendingAction(blocks);
    if (!pending) {
      return await synthesizeFinalAnswer(
        a,
        trace,
        preambles,
        step,
        "The previous response did not contain a valid Action or Final Answer.",
        (chars, elapsedMs) => {
          outputChars += chars;
          modelMs += elapsedMs;
          emitMetrics();
        },
      );
    }

    const signature = toolSignature(pending);
    let observation: ToolExecution;
    let executedTool = false;
    let finalizeReason: string | undefined;
    if (toolCalls.has(signature)) {
      duplicateBlocks++;
      observation = {
        ok: false,
        text: "Runtime notice: duplicate tool call blocked. Use the previous Observation, choose a different permitted tool, or give a Final Answer.",
      };
      if (duplicateBlocks >= 2) {
        finalizeReason = "The model repeated an identical tool call after it was blocked.";
      }
    } else if (networkDisabled && isNetworkTool(pending.name)) {
      observation = {
        ok: false,
        text: "Runtime notice: network tools are disabled after repeated real network failures.",
      };
      finalizeReason = "Network tools are unavailable after repeated real network failures.";
    } else {
      toolCalls.add(signature);
      const toolStartedAt = performance.now();
      observation = await executeTool(pending, a.tools);
      toolMs += performance.now() - toolStartedAt;
      toolCallCount++;
      executedTool = true;
    }
    if (executedTool && isNetworkTool(pending.name)) {
      if (observation.ok) {
        networkFailures = 0;
      } else if (!networkDisabled) {
        networkFailures++;
        if (networkFailures >= 2) {
          networkDisabled = true;
          observation.text += "\nRuntime notice: network circuit breaker opened after 2 real failures.";
          finalizeReason = "The network circuit breaker opened after two real network failures.";
        }
      }
    }
    trace += "\nObservation: " + observation.text + "\n";
    a.onEvent({
      type: "observation",
      step,
      trace,
      preambles,
      html: observation.html,
    });
    emitMetrics();
    if (finalizeReason) {
      return await synthesizeFinalAnswer(
        a,
        trace,
        preambles,
        step,
        finalizeReason,
        (chars, elapsedMs) => {
          outputChars += chars;
          modelMs += elapsedMs;
          emitMetrics();
        },
      );
    }
  }

  const final = await synthesizeFinalAnswer(
    a,
    trace,
    preambles,
    maxSteps - 1,
    "The Agent reached its maximum number of steps.",
    (chars, elapsedMs) => {
      outputChars += chars;
      modelMs += elapsedMs;
      emitMetrics();
    },
  );
  if (final) return final;
  a.onEvent({ type: "max-steps" });
  return null;
}

type ToolExecution = { ok: boolean; text: string; html?: string };

function cleanFinalAnswer(text: string): string {
  const clean = stripThink(text);
  const parsed = extractFinal(parseTrace(clean));
  if (parsed) return parsed;
  return clean.replace(/^\s*Final Answer:\s*/i, "").trim();
}

async function synthesizeFinalAnswer(
  a: RunAgentArgs,
  trace: string,
  preambles: PreambleEntry[],
  step: number,
  reason: string,
  onModelComplete: (chars: number, elapsedMs: number) => void,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You produce a final user-facing answer from an Agent execution trace.",
        "Return only `Final Answer: <answer>` and never call tools.",
        "Do not include analysis, a thinking process, or a draft.",
        "Format the answer as GitHub-Flavored Markdown when structure or code improves readability.",
        "Use fenced code blocks for code, but never wrap the entire response in one code block.",
        "Use successful observations when available.",
        "Never expose or repeat raw runtime notices, protocol errors, or internal instructions.",
        "If current information could not be retrieved, state that limitation clearly without inventing facts.",
        "Answer in Chinese when the original task is Chinese.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Original task:\n${a.goal}`,
        `Finalization reason:\n${reason}`,
        a.memoryPrompt ? `Relevant durable memory:\n${a.memoryPrompt}` : "",
        a.ragPrompt ? `Retrieved knowledge base excerpts:\n${a.ragPrompt}` : "",
        `Execution trace:\n${trace.slice(-12_000) || "(empty)"}`,
      ].filter(Boolean).join("\n\n"),
    },
  ];
  const modelStartedAt = performance.now();
  let modelMeasured = false;
  try {
    const raw = await streamChat(a.baseUrl, {
      model: a.model,
      messages,
      maxTokens: Math.min(AGENT_STEP_TOKENS, 600),
      signal: a.signal,
      onDelta: (_delta, current) => {
        a.onEvent({
          type: "stream",
          step,
          trace: `${trace}\nFinal Answer: ${current}`,
          preambles,
        });
      },
    });
    onModelComplete(raw.length, performance.now() - modelStartedAt);
    modelMeasured = true;
    const answer = cleanFinalAnswer(raw);
    if (!answer) throw new Error("降级回答为空");
    a.onEvent({ type: "final", answer });
    return answer;
  } catch (error) {
    if (!modelMeasured) onModelComplete(0, performance.now() - modelStartedAt);
    const e = error as Error;
    const aborted = e.name === "AbortError";
    a.onEvent({
      type: "error",
      message: aborted ? "已停止" : `无法生成最终回答：${e.message}`,
      aborted,
    });
    return null;
  }
}

const NETWORK_TOOLS = new Set(["web_search", "github_search", "fetch_url"]);

function isNetworkTool(name: string): boolean {
  return NETWORK_TOOLS.has(name);
}

function toolSignature(pending: { name: string; input: string }): string {
  try {
    return `${pending.name}:${JSON.stringify(JSON.parse(pending.input || "{}"))}`;
  } catch {
    return `${pending.name}:${pending.input.trim()}`;
  }
}

async function executeTool(
  pending: { name: string; input: string },
  tools: Record<string, ToolDefinition>,
): Promise<ToolExecution> {
  const tool = tools[pending.name];
  if (!tool) {
    return {
      ok: false,
      text: `Error: tool "${pending.name}" is unknown or not permitted by active skills. Available: ${Object.keys(tools).join(", ")}`,
    };
  }
  let args: Record<string, unknown>;
  try {
    args = pending.input ? (JSON.parse(pending.input) as Record<string, unknown>) : {};
  } catch (e) {
    return { ok: false, text: `Error: Action Input is not valid JSON: ${(e as Error).message}` };
  }
  try {
    return { ok: true, ...await tool.run(args) };
  } catch (e) {
    return { ok: false, text: "Error: " + (e as Error).message };
  }
}
