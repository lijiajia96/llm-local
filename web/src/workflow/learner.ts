import { streamChat } from "../api/openai";
import { stripThink } from "../agent/parser";
import type { AgentProfile } from "../agents/types";
import type { ChatMessage } from "../types";
import type { WorkflowTemplateRepository } from "./templateRepository";
import type {
  WorkflowLearningEvaluation,
  WorkflowRun,
  WorkflowTemplate,
} from "./types";

const MIN_LEARNING_SCORE = 0.8;
const REINFORCE_MATCH_SCORE = 0.72;
const EVALUATION_CONTEXT_BUDGET = 12_000;

function clampScore(value: unknown): number {
  const score = typeof value === "number" ? value : Number(value);
  return Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
}

function parseEvaluation(raw: string): WorkflowLearningEvaluation {
  const clean = stripThink(raw).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Flow critic did not return JSON");
  const value = JSON.parse(clean.slice(start, end + 1)) as Record<string, unknown>;
  const triggerExamples = Array.isArray(value.triggerExamples)
    ? value.triggerExamples.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 5)
    : [];
  return {
    success: value.success === true,
    score: clampScore(value.score),
    reason: String(value.reason ?? "").trim().slice(0, 500),
    name: String(value.name ?? "").trim().slice(0, 80),
    description: String(value.description ?? "").trim().slice(0, 500),
    triggerExamples,
  };
}

function evaluationEvidence(run: WorkflowRun): string {
  let remaining = EVALUATION_CONTEXT_BUDGET;
  const sections: string[] = [];
  for (const node of run.nodes) {
    const header = `[${node.id}] ${node.title} (${node.status})\n`;
    const output = (node.result ?? node.error ?? "(no output)")
      .slice(0, Math.max(0, remaining - header.length));
    if (!output) break;
    sections.push(header + output);
    remaining -= header.length + output.length;
  }
  const finalHeader = "\n\nFINAL ANSWER:\n";
  const finalAnswer = (run.finalAnswer ?? "").slice(
    0,
    Math.max(0, remaining - finalHeader.length),
  );
  return sections.join("\n\n") + finalHeader + finalAnswer;
}

export async function evaluateWorkflowForLearning(args: {
  baseUrl: string;
  model: string;
  run: WorkflowRun;
  signal: AbortSignal;
}): Promise<WorkflowLearningEvaluation> {
  const structurallyComplete = args.run.status === "completed"
    && args.run.nodes.every((node) => node.status === "completed" && node.result?.trim())
    && Boolean(args.run.finalAnswer?.trim());
  if (!structurallyComplete) {
    return {
      success: false,
      score: 0,
      reason: "Flow did not complete with evidence from every node.",
      name: "",
      description: "",
      triggerExamples: [],
    };
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You are a strict workflow critic and reusable-pattern curator.
Judge whether the execution evidence actually satisfies the original goal. A successful process,
exit code, or completed node is not enough when the business result is empty or invalid.

Return one JSON object only:
{
  "success": true,
  "score": 0.0,
  "reason": "brief evidence-based judgment",
  "name": "short reusable workflow name",
  "description": "task-agnostic description of when this workflow structure should be used",
  "triggerExamples": ["similar request example", "another similar request"]
}

Only mark success when the final answer is supported by node evidence.
Descriptions and examples must remove task-specific values and must not mention Agent names.`,
    },
    {
      role: "user",
      content: `ORIGINAL GOAL:\n${args.run.goal}\n\nPLAN:\n${args.run.summary}\n\nEXECUTION EVIDENCE:\n${evaluationEvidence(args.run)}`,
    },
  ];
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = window.setTimeout(abort, 45_000);
  args.signal.addEventListener("abort", abort, { once: true });
  try {
    const raw = await streamChat(args.baseUrl, {
      model: args.model,
      messages,
      temperature: 0.1,
      maxTokens: 700,
      responseFormat: { type: "json_object" },
      chatTemplateKwargs: { enable_thinking: false },
      signal: controller.signal,
    });
    const evaluation = parseEvaluation(raw);
    if (!evaluation.name || !evaluation.description) {
      return { ...evaluation, success: false, score: 0 };
    }
    return evaluation;
  } catch (error) {
    return {
      success: false,
      score: 0,
      reason: `Flow critic failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      name: "",
      description: "",
      triggerExamples: [],
    };
  } finally {
    window.clearTimeout(timer);
    args.signal.removeEventListener("abort", abort);
  }
}

export async function learnWorkflowTemplate(args: {
  run: WorkflowRun;
  evaluation: WorkflowLearningEvaluation;
  agents: AgentProfile[];
  repository: WorkflowTemplateRepository;
}): Promise<WorkflowTemplate | null> {
  const { run, evaluation, repository } = args;
  run.qualityScore = evaluation.score;
  run.qualityReason = evaluation.reason;
  if (!evaluation.success || evaluation.score < MIN_LEARNING_SCORE) return null;

  const existingForRun = await repository.findBySourceRun(run.id);
  if (existingForRun) return existingForRun;

  const reused = run.matchedTemplates?.[0];
  if (reused && reused.score >= REINFORCE_MATCH_SCORE) {
    const existing = await repository.get(reused.id);
    if (existing) {
      const reinforced: WorkflowTemplate = {
        ...existing,
        qualityScore: Math.max(existing.qualityScore, evaluation.score),
        qualityReason: evaluation.reason,
        successCount: existing.successCount + 1,
        updatedAt: new Date().toISOString(),
      };
      await repository.put(reinforced);
      return reinforced;
    }
  }

  const agentMap = new Map(args.agents.map((agent) => [agent.id, agent]));
  const now = new Date().toISOString();
  const template: WorkflowTemplate = {
    id: crypto.randomUUID(),
    sourceRunId: run.id,
    name: evaluation.name,
    description: evaluation.description,
    triggerExamples: evaluation.triggerExamples.length
      ? evaluation.triggerExamples
      : run.triggerExamples,
    exampleGoal: run.goal,
    summary: run.summary,
    nodes: run.nodes.map((node) => {
      const agent = agentMap.get(node.agentId);
      return {
        id: node.id,
        title: node.title,
        goalExample: node.goal,
        requiredSkillIds: node.requiredSkillIds.length
          ? node.requiredSkillIds
          : agent?.skillIds ?? [],
        requiredTools: node.requiredTools.length
          ? node.requiredTools
          : agent?.allowedTools ?? [],
        dependsOn: node.dependsOn,
      };
    }),
    qualityScore: evaluation.score,
    qualityReason: evaluation.reason,
    successCount: 1,
    enabled: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const indexed = await repository.embedForStorage(template);
  await repository.put(indexed);
  return indexed;
}
