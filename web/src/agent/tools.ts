import { TOOL_TIMEOUT_MS } from "../config";

export type ToolResult = {
  /** Text observation for the LLM. */
  text: string;
  /** Optional inline HTML (e.g. mermaid SVG) attached to the observation card. */
  html?: string;
};

export type ToolDefinition = {
  name: string;
  desc: string;
  /** Args schema for prompt injection. Not validated at runtime. */
  args: Record<string, string>;
  run: (args: Record<string, unknown>) => Promise<ToolResult>;
};

export const CODE_MODE_TOOL_NAME = "code_mode";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n… (truncated)" : s);

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = TOOL_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function format(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "object") {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

function plainText(html: string): string {
  return new DOMParser()
    .parseFromString(html, "text/html")
    .body.textContent?.replace(/\s+/g, " ")
    .trim() ?? "";
}

async function searchRss(url: string, source: string): Promise<ToolResult> {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`${source} RSS HTTP ${res.status}`);
  const xml = new DOMParser().parseFromString(await res.text(), "text/xml");
  if (xml.querySelector("parsererror")) throw new Error(`${source} RSS parse failed`);
  const items = Array.from(xml.querySelectorAll("item")).slice(0, 6).map((item, index) => {
    const title = item.querySelector("title")?.textContent?.trim() || "(untitled)";
    const link = item.querySelector("link")?.textContent?.trim() || "";
    const description = plainText(item.querySelector("description")?.textContent ?? "");
    const published = item.querySelector("pubDate")?.textContent?.trim() || "(unknown)";
    return [
      `${index + 1}. ${title}`,
      `Published: ${published}`,
      `URL: ${link}`,
      description ? `Summary: ${description}` : "",
    ].filter(Boolean).join("\n");
  });
  if (!items.length) throw new Error(`${source} RSS returned no results`);
  return { text: clip(`${source} RSS results:\n\n${items.join("\n\n")}`, 4000) };
}

async function fallbackWebSearch(query: string): Promise<ToolResult> {
  if (/\bbbc\b/i.test(query)) {
    return await searchRss("/api/bbc-news", "BBC News");
  }
  return await searchRss(
    `/api/bing-search?q=${encodeURIComponent(query)}&format=rss`,
    "Bing Search",
  );
}

type GitHubRepo = {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  default_branch: string;
  updated_at: string;
};

type GitHubTag = {
  name: string;
  commit: { sha: string };
};

type GitHubRelease = {
  name: string | null;
  tag_name: string;
  html_url: string;
  published_at: string | null;
  prerelease: boolean;
  draft: boolean;
};

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

async function githubJson<T>(path: string): Promise<T> {
  const res = await fetchWithTimeout(`https://api.github.com${path}`, { headers: GITHUB_HEADERS });
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      throw new Error("GitHub API rate limit exceeded");
    }
    throw new Error(`GitHub API HTTP ${res.status}`);
  }
  return await res.json() as T;
}

function githubRepoFromText(text: string): string | null {
  const urlMatch = text.match(/github\.com\/([\w.-]+\/[\w.-]+)/i);
  if (urlMatch?.[1]) return urlMatch[1].replace(/\.git$/i, "");
  const nameMatch = text.match(/(?:^|\s)([\w.-]+\/[\w.-]+)(?=\s|$)/);
  return nameMatch?.[1]?.replace(/\.git$/i, "") ?? null;
}

function cleanGitHubQuery(query: string): string {
  return query
    .replace(/(?:https?:\/\/)?github\.com\/?/gi, " ")
    .replace(/\b(github|latest|release|releases|tag|tags|version)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function describeGitHubRepo(fullName: string): Promise<string> {
  const repo = await githubJson<GitHubRepo>(`/repos/${fullName}`);
  const [tags, releases] = await Promise.all([
    githubJson<GitHubTag[]>(`/repos/${fullName}/tags?per_page=8`),
    githubJson<GitHubRelease[]>(`/repos/${fullName}/releases?per_page=5`),
  ]);
  const latestRelease = releases.find((r) => !r.draft && !r.prerelease);
  const latestTag = tags.find((t) => !/-rc\d*$/i.test(t.name)) ?? tags[0];
  const lines = [
    `Repository: ${repo.full_name}`,
    `URL: ${repo.html_url}`,
    `Description: ${repo.description ?? "(none)"}`,
    `Stars: ${repo.stargazers_count}`,
    `Default branch: ${repo.default_branch}`,
    `Updated: ${repo.updated_at}`,
    `Latest stable tag: ${latestTag?.name ?? "(none)"}`,
    `Recent tags: ${tags.map((t) => t.name).join(", ") || "(none)"}`,
  ];
  if (latestRelease) {
    lines.push(
      `Latest GitHub Release: ${latestRelease.name ?? latestRelease.tag_name}`,
      `Release tag: ${latestRelease.tag_name}`,
      `Published: ${latestRelease.published_at ?? "(unknown)"}`,
      `Release URL: ${latestRelease.html_url}`,
    );
  } else {
    lines.push("GitHub Releases: none; use the latest stable tag above.");
  }
  return lines.join("\n");
}

async function searchGitHub(query: string): Promise<ToolResult> {
  const explicitRepo = githubRepoFromText(query);
  if (explicitRepo) return { text: await describeGitHubRepo(explicitRepo) };

  const cleaned = cleanGitHubQuery(query);
  if (!cleaned) throw new Error("GitHub repository query required");
  const result = await githubJson<{ items: GitHubRepo[] }>(
    `/search/repositories?q=${encodeURIComponent(`${cleaned} in:name`)}&per_page=5`,
  );
  if (!result.items.length) return { text: "No GitHub repositories found." };

  const normalized = cleaned.toLowerCase();
  const top = result.items.find((repo) => {
    const [owner = "", name = ""] = repo.full_name.toLowerCase().split("/");
    return repo.full_name.toLowerCase() === normalized
      || name === normalized
      || (owner === normalized && name === normalized);
  }) ?? result.items[0]!;
  const details = await describeGitHubRepo(top.full_name);
  const alternatives = result.items.filter((repo) => repo.full_name !== top.full_name).map(
    (repo, i) => `${i + 2}. ${repo.full_name} — ${repo.html_url} — ${repo.description ?? ""}`,
  );
  return {
    text: clip(
      `${details}\n\nOther repository matches:\n${alternatives.join("\n") || "(none)"}`,
      4000,
    ),
  };
}

const webSearch: ToolDefinition = {
  name: "web_search",
  desc: "Search the web. GitHub-related queries use the reliable GitHub API automatically.",
  args: { query: "string" },
  run: async (args) => {
    const q = String(args.query ?? "").trim();
    if (!q) throw new Error("query required");
    if (/\bgithub\b|github\.com/i.test(q)) return await searchGitHub(q);
    try {
      const res = await fetchWithTimeout(
        `https://s.jina.ai/${encodeURIComponent(q)}`,
        { headers: { Accept: "text/plain" } },
        8_000,
      );
      if (!res.ok) throw new Error(`search HTTP ${res.status}`);
      return { text: clip(await res.text(), 3500) };
    } catch {
      return await fallbackWebSearch(q);
    }
  },
};

const githubSearch: ToolDefinition = {
  name: "github_search",
  desc: "Search GitHub repositories and return repository metadata, recent tags, and the latest release. Prefer this for GitHub/version/release questions.",
  args: { query: "string  // repository name, keywords, or a github.com/owner/repo URL" },
  run: async (args) => {
    const q = String(args.query ?? "").trim();
    if (!q) throw new Error("query required");
    return await searchGitHub(q);
  },
};

const fetchUrl: ToolDefinition = {
  name: "fetch_url",
  desc: "Fetch a web page and return its main content. GitHub repository URLs use the GitHub API.",
  args: { url: "string" },
  run: async (args) => {
    const url = String(args.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http(s)://");
    const githubRepo = githubRepoFromText(url);
    if (githubRepo) return { text: await describeGitHubRepo(githubRepo) };
    const res = await fetchWithTimeout(
      `https://r.jina.ai/${url}`,
      { headers: { Accept: "text/plain" } },
      8_000,
    );
    if (!res.ok) throw new Error(`fetch HTTP ${res.status}`);
    return { text: clip(await res.text(), 4000) };
  },
};

const runJs: ToolDefinition = {
  name: "run_js",
  desc: "Run JavaScript in a sandbox. End with `return X;` or a bare expression. No network, no DOM.",
  args: { code: "string  // e.g. 'return Math.sqrt(2)*100'" },
  run: async (args) => {
    const src = String(args.code ?? "");
    if (!src.trim()) throw new Error("empty code");
    // Strategy 1: has `return` → run as full function body
    if (/(^|\s|;|})return\s/.test(src)) {
      const fn = new Function('"use strict"; ' + src) as () => unknown;
      return { text: clip(format(fn()), 2000) };
    }
    // Strategy 2: try as a single expression
    try {
      const fn = new Function('"use strict"; return (' + src + ")") as () => unknown;
      return { text: clip(format(fn()), 2000) };
    } catch {
      /* fall through */
    }
    // Strategy 3: statement list → auto-return the last statement
    const stmts = src.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
    if (!stmts.length) throw new Error("empty code");
    const last = stmts[stmts.length - 1];
    const body = stmts.slice(0, -1).join(";\n") + ";\nreturn (" + last + ");";
    const fn = new Function('"use strict"; ' + body) as () => unknown;
    return { text: clip(format(fn()), 2000) };
  },
};

const getTime: ToolDefinition = {
  name: "get_time",
  desc: "Return current local date/time and timezone. No arguments needed.",
  args: {},
  run: async () => {
    const d = new Date();
    return { text: `${d.toString()} (ISO: ${d.toISOString()})` };
  },
};

const renderMermaid: ToolDefinition = {
  name: "render_mermaid",
  desc: "Render a Mermaid diagram. Pass the raw mermaid code (flowchart, sequence, etc.).",
  args: { code: "string  // e.g. 'flowchart LR\\nA-->B'" },
  run: async (args) => {
    const { renderMermaidToSvg } = await import("../ui/mermaid");
    const svg = await renderMermaidToSvg(String(args.code ?? ""));
    return { text: `Diagram rendered (SVG ${svg.length} chars).`, html: svg };
  },
};

const CODE_MODE_TOOLS = new Set(["run_js", "get_time", "memory_search", "render_mermaid"]);

function resolveResultRefs(value: unknown, results: ToolResult[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveResultRefs(entry, results));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length === 1 && Number.isInteger(object.$result)) {
    const index = Number(object.$result);
    const result = results[index];
    if (!result) throw new Error(`result reference ${index} is unavailable`);
    return result.text;
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [key, resolveResultRefs(entry, results)]),
  );
}

export function createCodeModeTool(
  permittedTools: Record<string, ToolDefinition>,
): ToolDefinition {
  const nestedTools = Object.fromEntries(
    Object.entries(permittedTools).filter(([name]) => CODE_MODE_TOOLS.has(name)),
  );
  return {
    name: CODE_MODE_TOOL_NAME,
    desc: "Run a bounded plan of up to 4 permitted local tool calls in one Agent action. Later args may use {\"$result\":0} to reference an earlier text result.",
    args: {
      calls: "Array<{tool:string,args:object}>  // max 4; local read-only tools only",
    },
    run: async (args) => {
      if (!Array.isArray(args.calls) || !args.calls.length) {
        throw new Error("calls must be a non-empty array");
      }
      if (args.calls.length > 4) throw new Error("code_mode accepts at most 4 calls");
      const results: ToolResult[] = [];
      const lines: string[] = [];
      for (let i = 0; i < args.calls.length; i++) {
        const call = args.calls[i] as Record<string, unknown>;
        const name = String(call.tool ?? "");
        const tool = nestedTools[name];
        if (!tool) {
          throw new Error(
            `nested tool "${name}" is unavailable; allowed: ${Object.keys(nestedTools).join(", ") || "(none)"}`,
          );
        }
        const resolved = resolveResultRefs(call.args ?? {}, results);
        if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
          throw new Error(`calls[${i}].args must resolve to an object`);
        }
        const result = await tool.run(resolved as Record<string, unknown>);
        results.push(result);
        lines.push(`[${i}] ${name}\n${result.text}`);
      }
      return { text: clip(lines.join("\n\n"), 6000) };
    },
  };
}

export const TOOLS: Record<string, ToolDefinition> = {
  [webSearch.name]: webSearch,
  [githubSearch.name]: githubSearch,
  [fetchUrl.name]: fetchUrl,
  [runJs.name]: runJs,
  [getTime.name]: getTime,
  [renderMermaid.name]: renderMermaid,
};
