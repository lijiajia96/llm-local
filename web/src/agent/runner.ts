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
      }),
    },
    { role: "user", content: a.goal },
  ];
  let trace = "";
  const preambles: PreambleEntry[] = [];
  const toolCalls = new Set<string>();
  let networkFailures = 0;
  let networkDisabled = false;
  a.onEvent({
    type: "context",
    memories: a.memories,
    skills: a.skills,
    tools: Object.keys(a.tools),
  });

  for (let step = 0; step < AGENT_MAX_STEPS; step++) {
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
      const tail = blocks.length ? blocks[blocks.length - 1]!.text : trace;
      a.onEvent({ type: "final", answer: tail || "(空回复)" });
      return tail;
    }

    const signature = toolSignature(pending);
    let observation: ToolExecution;
    if (toolCalls.has(signature)) {
      observation = {
        ok: false,
        text: "Error: duplicate tool call blocked. Use the previous Observation; do not retry.",
      };
    } else if (networkDisabled && isNetworkTool(pending.name)) {
      observation = {
        ok: false,
        text: "Error: network tools are disabled after repeated failures. Do not retry web_search, github_search, or fetch_url. Give a final answer using available information and clearly state the limitation.",
      };
    } else {
      toolCalls.add(signature);
      observation = await executeTool(pending, a.tools);
    }
    if (isNetworkTool(pending.name)) {
      if (observation.ok) {
        networkFailures = 0;
      } else if (!networkDisabled) {
        networkFailures++;
        if (networkFailures >= 2) {
          networkDisabled = true;
          observation.text += "\nNetwork circuit breaker opened after 2 failures. Do not call another network tool; produce Final Answer now.";
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
  }

  a.onEvent({ type: "max-steps" });
  return null;
}

type ToolExecution = { ok: boolean; text: string; html?: string };

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
