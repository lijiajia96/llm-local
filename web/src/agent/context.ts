import type { MemoryRepository } from "../memory/repository";
import { formatMemoryContext } from "../memory/context";
import { createMemoryTools } from "../memory/tools";
import type { MemoryMatch } from "../memory/types";
import { formatRagContext } from "../rag/context";
import type { RagRepository } from "../rag/repository";
import type { RagMatch } from "../rag/types";
import type { SkillRepository } from "../skills/repository";
import { allowedTools, formatSkillContext, matchSkills } from "../skills/matcher";
import type { SkillMatch } from "../skills/types";
import {
  CODE_MODE_TOOL_NAME,
  createCodeModeTool,
  TOOLS,
  type ToolDefinition,
} from "./tools";

export type AgentContext = {
  memories: MemoryMatch[];
  ragMatches: RagMatch[];
  skills: SkillMatch[];
  tools: Record<string, ToolDefinition>;
  memoryPrompt: string;
  ragPrompt: string;
  skillPrompt: string;
};

export type AgentContextOptions = {
  skillIds?: string[];
  allowedTools?: string[];
  ragRepository?: RagRepository;
  ragEnabled?: boolean;
};

export async function prepareAgentContext(
  goal: string,
  memoryRepository: MemoryRepository,
  skillRepository: SkillRepository,
  options: AgentContextOptions = {},
): Promise<AgentContext> {
  const [memories, skills, ragMatches] = await Promise.all([
    memoryRepository.search(goal, 6),
    skillRepository.list(),
    options.ragEnabled && options.ragRepository
      ? options.ragRepository.search(goal, 6).catch((error) => {
          console.warn("Agent RAG retrieval failed", error);
          return [];
        })
      : Promise.resolve([]),
  ]);
  const dynamicMatches = matchSkills(goal, skills);
  const explicitMatches: SkillMatch[] = skills
    .filter((skill) => skill.enabled && options.skillIds?.includes(skill.id))
    .map((skill) => ({ skill, score: 1, matchedTriggers: ["agent-profile"] }));
  const matches = [...new Map(
    [...dynamicMatches, ...explicitMatches].map((match) => [match.skill.id, match]),
  ).values()];
  const permitted = allowedTools(matches);
  if (options.allowedTools) {
    const roleTools = new Set(options.allowedTools);
    for (const tool of permitted) {
      if (!roleTools.has(tool)) permitted.delete(tool);
    }
  }
  const availableTools = { ...TOOLS, ...createMemoryTools(memoryRepository) };
  const tools: Record<string, ToolDefinition> = Object.fromEntries(
    Object.entries(availableTools).filter(([name]) => permitted.has(name)),
  );
  if (permitted.has(CODE_MODE_TOOL_NAME)) {
    tools[CODE_MODE_TOOL_NAME] = createCodeModeTool(tools);
  }
  return {
    memories,
    ragMatches,
    skills: matches,
    tools,
    memoryPrompt: formatMemoryContext(memories),
    ragPrompt: formatRagContext(ragMatches),
    skillPrompt: formatSkillContext(matches),
  };
}
