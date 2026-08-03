import { AGENT_MAX_STEPS, AGENT_STEP_TOKENS } from "../config";
import { streamChat } from "../api/openai";
import type { MemoryMatch } from "../memory/types";
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
} from "./parser";

export type AgentEvent =
  | { type: "context"; memories: MemoryMatch[]; skills: SkillMatch[]; tools: string[] }
  | { type: "step-start"; step: number }
  | { type: "stream"; step: number; trace: string; preambles: PreambleEntry[] }
  | { type: "step-end"; step: number; trace: string; preambles: PreambleEntry[] }
  | { type: "observation"; step: number; trace: string; preambles: PreambleEntry[]; html?: string }
  | { type: "final"; answer: string }
  | { type: "error"; message: string; aborted?: boolean }
  | { type: "max-steps" };

export type PreambleEntry = { afterBlockIdx: number; text: string };

export type RunAgentArgs = {
  baseUrl: string;
  model: string;
  goal: string;
  tools: Record<string, ToolDefinition>;
  memories: MemoryMatch[];
  skills: SkillMatch[];
  memoryPrompt: string;
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
  a.onEvent({
    type: "context",
    memories: a.memories,
    skills: a.skills,
    tools: Object.keys(a.tools),
  });

  const maxSteps = Math.min(20, Math.max(1, a.maxSteps ?? AGENT_MAX_STEPS));
  for (let step = 0; step < maxSteps; step++) {
    a.onEvent({ type: "step-start", step });

    const stepMessages = [...messages];
    if (trace) stepMessages.push({ role: "assistant", content: trace });

    let stepText: string;
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
      const e = err as Error;
      const aborted = e.name === "AbortError";
      a.onEvent({ type: "error", message: aborted ? "已停止" : e.message, aborted });
      return null;
    }

    const { preamble, body } = splitStepText(stepText);
    const cleaned = normalizePreamble(preamble);
    if (cleaned) preambles.push({ afterBlockIdx: parseTrace(trace).length, text: cleaned });

    trace += body;
    a.onEvent({ type: "step-end", step, trace, preambles });

    const blocks = parseTrace(trace);
    const finalAns = extractFinal(blocks);
    if (finalAns) {
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
      observation = await executeTool(pending, a.tools);
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
    if (finalizeReason) {
      return await synthesizeFinalAnswer(
        a,
        trace,
        preambles,
        step,
        finalizeReason,
      );
    }
  }

  const final = await synthesizeFinalAnswer(
    a,
    trace,
    preambles,
    maxSteps - 1,
    "The Agent reached its maximum number of steps.",
  );
  if (final) return final;
  a.onEvent({ type: "max-steps" });
  return null;
}

type ToolExecution = { ok: boolean; text: string; html?: string };

function cleanFinalAnswer(text: string): string {
  const withoutThinking = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*Final Answer:\s*/i, "")
    .trim();
  const parsed = extractFinal(parseTrace(text));
  return (parsed ?? withoutThinking).trim();
}

async function synthesizeFinalAnswer(
  a: RunAgentArgs,
  trace: string,
  preambles: PreambleEntry[],
  step: number,
  reason: string,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You produce a final user-facing answer from an Agent execution trace.",
        "Return only `Final Answer: <answer>` and never call tools.",
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
        `Execution trace:\n${trace.slice(-12_000) || "(empty)"}`,
      ].join("\n\n"),
    },
  ];
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
    const answer = cleanFinalAnswer(raw);
    if (!answer) throw new Error("降级回答为空");
    a.onEvent({ type: "final", answer });
    return answer;
  } catch (error) {
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
