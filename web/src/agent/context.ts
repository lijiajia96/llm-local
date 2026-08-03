import type { MemoryRepository } from "../memory/repository";
import { formatMemoryContext } from "../memory/context";
import { createMemoryTools } from "../memory/tools";
import type { MemoryMatch } from "../memory/types";
import type { SkillRepository } from "../skills/repository";
import { allowedTools, formatSkillContext, matchSkills } from "../skills/matcher";
import type { SkillMatch } from "../skills/types";
import { TOOLS, type ToolDefinition } from "./tools";

export type AgentContext = {
  memories: MemoryMatch[];
  skills: SkillMatch[];
  tools: Record<string, ToolDefinition>;
  memoryPrompt: string;
  skillPrompt: string;
};

export type AgentContextOptions = {
  skillIds?: string[];
  allowedTools?: string[];
};

export async function prepareAgentContext(
  goal: string,
  memoryRepository: MemoryRepository,
  skillRepository: SkillRepository,
  options: AgentContextOptions = {},
): Promise<AgentContext> {
  const [memories, skills] = await Promise.all([
    memoryRepository.search(goal, 6),
    skillRepository.list(),
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
  const allTools = { ...TOOLS, ...createMemoryTools(memoryRepository) };
  const tools = Object.fromEntries(
    Object.entries(allTools).filter(([name]) => permitted.has(name)),
  );
  return {
    memories,
    skills: matches,
    tools,
    memoryPrompt: formatMemoryContext(memories),
    skillPrompt: formatSkillContext(matches),
  };
}
