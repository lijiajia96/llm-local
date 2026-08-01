import type { ToolDefinition } from "../agent/tools";
import type { MemoryRepository } from "./repository";
import type { MemoryKind } from "./types";

const KINDS = new Set<MemoryKind>(["preference", "fact", "episode"]);

export function createMemoryTools(memory: MemoryRepository): Record<string, ToolDefinition> {
  const memorySearch: ToolDefinition = {
    name: "memory_search",
    desc: "Search durable memory for relevant user preferences, facts, and prior task episodes.",
    args: { query: "string" },
    run: async (args) => {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("query required");
      const matches = await memory.search(query, 6);
      if (!matches.length) return { text: "No relevant memory found." };
      return {
        text: matches.map(({ record, score }, index) =>
          `${index + 1}. [${record.kind}] ${record.title} (score=${score.toFixed(2)})\n${record.content}`,
        ).join("\n\n"),
      };
    },
  };

  const memorySave: ToolDefinition = {
    name: "memory_save",
    desc: "Save a durable user preference or fact. Do not save transient details or private secrets.",
    args: {
      kind: "preference | fact",
      title: "short string",
      content: "string",
      tags: "optional string[]",
    },
    run: async (args) => {
      const kind = String(args.kind ?? "") as MemoryKind;
      if (!KINDS.has(kind) || kind === "episode") {
        throw new Error("kind must be preference or fact");
      }
      const title = String(args.title ?? "").trim();
      const content = String(args.content ?? "").trim();
      if (!title || !content) throw new Error("title and content required");
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
      const record = await memory.save({
        kind,
        title,
        content,
        tags,
        importance: 0.85,
        source: "agent",
      });
      return { text: `Memory saved: ${record.id} (${record.kind}) ${record.title}` };
    },
  };

  return {
    [memorySearch.name]: memorySearch,
    [memorySave.name]: memorySave,
  };
}
