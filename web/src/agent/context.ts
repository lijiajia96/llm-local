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

export async function prepareAgentContext(
  goal: string,
  memoryRepository: MemoryRepository,
  skillRepository: SkillRepository,
): Promise<AgentContext> {
  const [memories, skills] = await Promise.all([
    memoryRepository.search(goal, 6),
    skillRepository.list(),
  ]);
  const matches = matchSkills(goal, skills);
  const permitted = allowedTools(matches);
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
