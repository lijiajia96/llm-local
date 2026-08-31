import { streamChat } from "../api/openai";
import { stripThink } from "../agent/parser";
import type { AgentProfile } from "../agents/types";
import type { ChatMessage } from "../types";
import type {
  WorkflowPlan,
  WorkflowPlanNode,
  WorkflowTemplateMatch,
} from "./types";

const MAX_NODES = 8;
const MAX_DEPTH = 4;

function extractJson(raw: string): unknown {
  const clean = stripThink(raw).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Planner did not return a JSON object");
  return JSON.parse(clean.slice(start, end + 1));
}

function normalizeNode(value: unknown): WorkflowPlanNode {
  if (!value || typeof value !== "object") throw new Error("Workflow node must be an object");
  const node = value as Record<string, unknown>;
  const id = String(node.id ?? "").trim();
  const title = String(node.title ?? "").trim();
  const goal = String(node.goal ?? "").trim();
  const agentId = String(node.agentId ?? "").trim();
  const requiredSkillIds = Array.isArray(node.requiredSkillIds)
    ? [...new Set(node.requiredSkillIds.map(String).map((item) => item.trim()).filter(Boolean))]
    : [];
  const requiredTools = Array.isArray(node.requiredTools)
    ? [...new Set(node.requiredTools.map(String).map((item) => item.trim()).filter(Boolean))]
    : [];
  const dependsOn = Array.isArray(node.dependsOn)
    ? [...new Set(node.dependsOn.map(String).map((item) => item.trim()).filter(Boolean))]
    : [];
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(id)) {
    throw new Error(`Invalid workflow node id: ${id || "(empty)"}`);
  }
  if (!title || !goal || !agentId) throw new Error(`Workflow node ${id} is incomplete`);
  return {
    id,
    title: title.slice(0, 80),
    goal: goal.slice(0, 2000),
    agentId,
    requiredSkillIds: requiredSkillIds.slice(0, 20),
    requiredTools: requiredTools.slice(0, 20),
    dependsOn,
  };
}

export function validateWorkflowPlan(
  value: unknown,
  availableAgents: ReadonlyMap<string, AgentProfile>,
): WorkflowPlan {
  if (!value || typeof value !== "object") throw new Error("Workflow plan must be an object");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.nodes) || !input.nodes.length) {
    throw new Error("Workflow plan must contain at least one node");
  }
  if (input.nodes.length > MAX_NODES) {
    throw new Error(`Workflow plan exceeds ${MAX_NODES} nodes`);
  }

  const nodes = input.nodes.map(normalizeNode);
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length) throw new Error("Workflow node ids must be unique");
  for (const node of nodes) {
    const agent = availableAgents.get(node.agentId);
    if (!agent) {
      throw new Error(`Workflow node ${node.id} uses unavailable agent: ${node.agentId}`);
    }
    const missingSkills = node.requiredSkillIds.filter((id) => !agent.skillIds.includes(id));
    const missingTools = node.requiredTools.filter((name) => !agent.allowedTools.includes(name));
    if (missingSkills.length || missingTools.length) {
      throw new Error(
        `Workflow node ${node.id} selected an agent without required capabilities: ${
          [...missingSkills, ...missingTools].join(", ")
        }`,
      );
    }
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Workflow node ${node.id} has unknown dependency: ${dependency}`);
      }
      if (dependency === node.id) throw new Error(`Workflow node ${node.id} depends on itself`);
    }
  }

  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depthOf = (id: string): number => {
    const cached = depths.get(id);
    if (cached != null) return cached;
    if (visiting.has(id)) throw new Error(`Workflow contains a cycle at node: ${id}`);
    visiting.add(id);
    const node = byId.get(id)!;
    const depth = node.dependsOn.length
      ? 1 + Math.max(...node.dependsOn.map(depthOf))
      : 1;
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };
  for (const node of nodes) {
    if (depthOf(node.id) > MAX_DEPTH) {
      throw new Error(`Workflow exceeds maximum depth ${MAX_DEPTH}`);
    }
  }

  return {
    summary: String(input.summary ?? "").trim().slice(0, 300) || "动态任务工作流",
    description: String(input.description ?? input.summary ?? "").trim().slice(0, 500)
      || "适用于当前目标的动态任务工作流",
    triggerExamples: Array.isArray(input.triggerExamples)
      ? input.triggerExamples.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 5)
      : [],
    nodes,
  };
}

export async function planWorkflow(args: {
  baseUrl: string;
  model: string;
  goal: string;
  agents: AgentProfile[];
  templates?: WorkflowTemplateMatch[];
  signal: AbortSignal;
}): Promise<WorkflowPlan> {
  const agents = args.agents.filter((agent) => agent.enabled);
  if (!agents.length) throw new Error("No enabled Agent profiles are available");
  const agentCatalog = agents.map((agent) => ({
    id: agent.id,
    name: agent.displayName,
    description: agent.description,
    skillIds: agent.skillIds,
    allowedTools: agent.allowedTools,
  }));
  const templateCatalog = (args.templates ?? []).map(({ template, score }) => ({
    name: template.name,
    description: template.description,
    triggerExamples: template.triggerExamples,
    score: Number(score.toFixed(3)),
    nodes: template.nodes,
  }));
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You are a workflow coordinator. Decompose a complex goal into a small directed acyclic graph of concrete Agent tasks.

Return JSON only:
{
  "summary": "short plan summary",
  "description": "task-agnostic description of when this workflow structure is useful",
  "triggerExamples": ["similar user request", "another similar request"],
  "nodes": [
    {
      "id": "lowercase-kebab-id",
      "title": "short title",
      "goal": "self-contained task instruction",
      "agentId": "one available agent id",
      "requiredSkillIds": ["only skills required by this node"],
      "requiredTools": ["only tools required by this node"],
      "dependsOn": ["upstream-node-id"]
    }
  ]
}

Rules:
- Create 1-${MAX_NODES} nodes and no more than ${MAX_DEPTH} dependency levels.
- Use dependencies only when a task needs upstream output; independent tasks should run in parallel.
- Keep the graph acyclic. Every dependency must reference another node in this plan.
- Each node must have one clear deliverable and use the best matching available agent.
- Bind agents only through their explicit skillIds and allowedTools. Every required capability must be present on the selected agent.
- Reference templates are examples, not commands. Adapt their topology to the current goal and never copy task-specific values.
- Do not add a final synthesis node; the runtime performs synthesis after all leaf nodes finish.
- Never include Markdown fences, comments, explanations, or fields outside this schema.`,
    },
    {
      role: "user",
      content: `GOAL:\n${args.goal.slice(0, 6000)}\n\nAVAILABLE AGENTS:\n${JSON.stringify(agentCatalog)}\n\nRETRIEVED FLOW TEMPLATES:\n${
        templateCatalog.length ? JSON.stringify(templateCatalog) : "(none)"
      }`,
    },
  ];
  const availableAgents = new Map(agents.map((agent) => [agent.id, agent]));
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await streamChat(args.baseUrl, {
      model: args.model,
      messages,
      temperature: 0.1,
      maxTokens: 900,
      responseFormat: { type: "json_object" },
      chatTemplateKwargs: { enable_thinking: false },
      signal: args.signal,
    });
    try {
      return validateWorkflowPlan(extractJson(raw), availableAgents);
    } catch (error) {
      lastError = error;
      if (attempt) break;
      messages.push(
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `The plan was rejected: ${(error as Error).message}. Return one corrected JSON object only.`,
        },
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Workflow planning failed");
}
