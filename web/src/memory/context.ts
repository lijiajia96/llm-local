import type { MemoryMatch } from "./types";

const DEFAULT_BUDGET = 5000;

export function formatMemoryContext(matches: MemoryMatch[], budget = DEFAULT_BUDGET): string {
  if (!matches.length) return "";
  const sections: string[] = [];
  let used = 0;
  for (const { record, score } of matches) {
    const section = [
      `[${record.kind.toUpperCase()} | relevance=${score.toFixed(2)} | importance=${record.importance.toFixed(1)} | confidence=${record.confidence.toFixed(1)}]`,
      `${record.title}: ${record.content}`,
      `Scope: ${record.scope} | valid_from: ${record.validFrom}${record.validTo ? ` | valid_to: ${record.validTo}` : ""}`,
      record.tags.length ? `Tags: ${record.tags.join(", ")}` : "",
    ].filter(Boolean).join("\n");
    if (used + section.length > budget) break;
    sections.push(section);
    used += section.length;
  }
  return sections.join("\n\n");
}

export function inferMemoryFromUserText(text: string) {
  const preference = /(?:我喜欢|我偏好|我习惯|请默认|以后请|不要再)/.test(text);
  const explicit = /(?:请记住|记住这个|记一下|remember)/i.test(text);
  if (!preference && !explicit) return null;
  return {
    kind: preference ? "preference" as const : "fact" as const,
    title: preference ? "用户偏好" : "用户要求记住的信息",
    content: text,
    tags: preference ? ["preference", "user"] : ["remembered", "user"],
    importance: 0.85,
    source: "user" as const,
  };
}
