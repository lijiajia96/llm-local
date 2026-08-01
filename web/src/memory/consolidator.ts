import { streamChat } from "../api/openai";
import type { ChatMessage } from "../types";
import type { MemoryRepository } from "./repository";
import type { MemoryInput } from "./types";

type ExtractedMemory = {
  kind?: unknown;
  title?: unknown;
  content?: unknown;
  tags?: unknown;
  importance?: unknown;
  confidence?: unknown;
  scope?: unknown;
};

const EXTRACTION_PROMPT = `You are a background memory consolidator for a local AI agent.
Extract only durable information that will improve future interactions.

Keep:
- stable user preferences and constraints
- user/project facts that are likely to remain useful
- explicit decisions, conventions, or corrections

Do not keep:
- public facts obtained from tools or the web
- transient questions, calculations, greetings, or one-off task results
- passwords, tokens, credentials, private keys, or other secrets
- facts already represented by a more specific memory in the provided turn

Return exactly:
<memory_json>
[
  {
    "kind": "preference" | "fact",
    "title": "short canonical title",
    "content": "self-contained durable statement",
    "tags": ["lowercase", "tags"],
    "importance": 0.0 to 1.0,
    "confidence": 0.0 to 1.0,
    "scope": "user" | "project" | "agent"
  }
]
</memory_json>

Return an empty array when nothing deserves long-term memory. Maximum 3 memories.`;

function parseArray(raw: string): ExtractedMemory[] {
  const tagged = raw.match(/<memory_json>\s*([\s\S]*?)\s*<\/memory_json>/i)?.[1];
  const candidate = tagged ?? raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
  if (!candidate) return [];
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return Array.isArray(parsed) ? parsed.slice(0, 3) as ExtractedMemory[] : [];
  } catch {
    return [];
  }
}

function validate(item: ExtractedMemory): MemoryInput | null {
  if (item.kind !== "preference" && item.kind !== "fact") return null;
  if (typeof item.title !== "string" || typeof item.content !== "string") return null;
  const title = item.title.trim();
  const content = item.content.trim();
  if (!title || content.length < 8) return null;
  const scope = item.scope === "project" || item.scope === "agent" ? item.scope : "user";
  return {
    kind: item.kind,
    title,
    content,
    tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : [],
    importance: typeof item.importance === "number" ? item.importance : 0.65,
    confidence: typeof item.confidence === "number" ? item.confidence : 0.75,
    source: "agent",
    scope,
  };
}

export async function consolidateConversation(args: {
  baseUrl: string;
  model: string;
  userText: string;
  assistantText: string;
  memory: MemoryRepository;
}): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  const existing = await args.memory.search(args.userText, 8);
  const existingText = existing.length
    ? existing.map(({ record }) => `- [${record.kind}] ${record.title}: ${record.content}`).join("\n")
    : "(none)";
  const messages: ChatMessage[] = [
    { role: "system", content: EXTRACTION_PROMPT },
    {
      role: "user",
      content: `EXISTING RELEVANT MEMORY (do not duplicate):\n${existingText}\n\nUSER:\n${args.userText.slice(0, 5000)}\n\nASSISTANT:\n${args.assistantText.slice(0, 5000)}`,
    },
  ];
  try {
    const raw = await streamChat(args.baseUrl, {
      model: args.model,
      messages,
      temperature: 0.1,
      maxTokens: 700,
      signal: controller.signal,
    });
    const memories = parseArray(raw).map(validate).filter((item): item is MemoryInput => !!item);
    for (const memory of memories) await args.memory.save(memory);
    return memories.length;
  } finally {
    clearTimeout(timer);
  }
}
