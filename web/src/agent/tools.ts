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

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n… (truncated)" : s);

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);
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
    const res = await fetchWithTimeout(
      `https://s.jina.ai/${encodeURIComponent(q)}`,
      { headers: { Accept: "text/plain" } },
    );
    if (!res.ok) throw new Error(`search HTTP ${res.status}`);
    return { text: clip(await res.text(), 3500) };
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

export const TOOLS: Record<string, ToolDefinition> = {
  [webSearch.name]: webSearch,
  [githubSearch.name]: githubSearch,
  [fetchUrl.name]: fetchUrl,
  [runJs.name]: runJs,
  [getTime.name]: getTime,
  [renderMermaid.name]: renderMermaid,
};
