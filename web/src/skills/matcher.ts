import type { SkillManifest, SkillMatch } from "./types";

function scoreSkill(goal: string, skill: SkillManifest): SkillMatch {
  const normalized = goal.toLowerCase();
  const matchedTriggers = skill.triggers.filter((trigger) => normalized.includes(trigger));
  const score = skill.always
    ? 1
    : matchedTriggers.reduce((sum, trigger) => sum + Math.min(1, trigger.length / 8), 0);
  return { skill, score, matchedTriggers };
}

export function matchSkills(goal: string, skills: SkillManifest[], limit = 3): SkillMatch[] {
  const enabled = skills.filter((skill) => skill.enabled);
  const always = enabled.filter((skill) => skill.always).map((skill) => scoreSkill(goal, skill));
  const matched = enabled
    .filter((skill) => !skill.always)
    .map((skill) => scoreSkill(goal, skill))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return [...always, ...matched];
}

export function allowedTools(matches: SkillMatch[]): Set<string> {
  return new Set(matches.flatMap((match) => match.skill.allowedTools));
}

export function formatSkillContext(matches: SkillMatch[]): string {
  return matches.map(({ skill, matchedTriggers }) => [
    `[SKILL: ${skill.name} v${skill.version}]`,
    `Purpose: ${skill.description}`,
    matchedTriggers.length ? `Matched triggers: ${matchedTriggers.join(", ")}` : "Always active",
    `Instructions: ${skill.prompt}`,
    `Allowed tools: ${skill.allowedTools.join(", ") || "(none)"}`,
  ].join("\n")).join("\n\n");
}
