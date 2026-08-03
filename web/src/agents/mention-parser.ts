import type { AgentMentionResult, AgentProfile } from "./types";

const MENTION_PREFIX = /^[@＠]/u;
const MENTION_BOUNDARY = /^[\s:：]$/u;

type ProfileAlias = {
  profile: AgentProfile;
  alias: string;
};

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function aliasesFor(profile: AgentProfile): string[] {
  return [...new Set([
    profile.name,
    profile.displayName,
    ...(profile.aliases ?? []),
  ].map((alias) => alias.trim()).filter(Boolean))];
}

function availableAliases(profiles: AgentProfile[]): ProfileAlias[] {
  return profiles
    .filter((profile) => profile.enabled)
    .flatMap((profile) => aliasesFor(profile).map((alias) => ({ profile, alias })))
    .sort((a, b) => b.alias.length - a.alias.length);
}

function isBoundary(value: string): boolean {
  return !value || MENTION_BOUNDARY.test(value);
}

function stripGoalPrefix(value: string): string {
  return value.replace(/^\s*[:：]?\s*/u, "").trim();
}

/**
 * Parse one routing mention at the beginning of the message.
 *
 * Supported forms:
 *   @researcher investigate vLLM
 *   @研究员：调研最新方案
 *   ＠代码员 修复这个问题
 *
 * Mentions in the middle of normal prose are intentionally ignored so email
 * addresses and quoted content cannot accidentally dispatch an Agent task.
 */
export function parseAgentMention(
  input: string,
  profiles: AgentProfile[],
): AgentMentionResult {
  const text = input.trimStart();
  if (!MENTION_PREFIX.test(text) || text.startsWith("@@") || text.startsWith("＠＠")) {
    return { kind: "none", text: input };
  }

  const body = text.slice(1);
  const normalizedBody = body.toLocaleLowerCase();
  const match = availableAliases(profiles).find(({ alias }) => {
    const normalizedAlias = normalize(alias);
    if (!normalizedBody.startsWith(normalizedAlias)) return false;
    return isBoundary(body.slice(alias.length, alias.length + 1));
  });

  if (match) {
    return {
      kind: "matched",
      profile: match.profile,
      mention: text.slice(0, match.alias.length + 1),
      goal: stripGoalPrefix(body.slice(match.alias.length)),
    };
  }

  const unknown = body.match(/^([^\s:：]*)/u)?.[1] ?? "";
  return {
    kind: "unknown",
    mention: text.slice(0, unknown.length + 1),
    goal: stripGoalPrefix(body.slice(unknown.length)),
  };
}

/**
 * Return enabled profiles matching the partial leading mention. Intended for
 * the future @ autocomplete menu.
 */
export function suggestAgentProfiles(
  input: string,
  profiles: AgentProfile[],
  limit = 8,
): AgentProfile[] {
  const text = input.trimStart();
  if (!MENTION_PREFIX.test(text)) return [];
  const query = normalize(text.slice(1).split(/[\s:：]/u, 1)[0] ?? "");
  const scored = profiles
    .filter((profile) => profile.enabled)
    .map((profile) => {
      const aliases = aliasesFor(profile).map(normalize);
      const prefix = aliases.some((alias) => alias.startsWith(query));
      const contains = aliases.some((alias) => alias.includes(query));
      return { profile, score: prefix ? 2 : contains ? 1 : 0 };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) =>
      b.score - a.score
      || a.profile.displayName.localeCompare(b.profile.displayName),
    );
  return scored.slice(0, Math.max(0, limit)).map(({ profile }) => profile);
}
