import type { ChatMessage } from "../types";
import { readContentDeltas } from "./stream";

export type StreamOpts = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  responseFormat?: Record<string, unknown>;
  chatTemplateKwargs?: Record<string, unknown>;
  signal?: AbortSignal;
  onDelta?: (delta: string, accumulated: string) => void;
};

const trimBase = (u: string) => u.trim().replace(/\/+$/, "");

export async function listModels(baseUrl: string, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(`${trimBase(baseUrl)}/models`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  return (data.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
}

export async function streamChat(baseUrl: string, opts: StreamOpts): Promise<string> {
  const body = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 1500,
    ...(opts.stop ? { stop: opts.stop } : {}),
    ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
    ...(opts.chatTemplateKwargs ? { chat_template_kwargs: opts.chatTemplateKwargs } : {}),
  };
  const res = await fetch(`${trimBase(baseUrl)}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  if (!res.body) throw new Error("No response body");
  let acc = "";
  for await (const delta of readContentDeltas(res.body)) {
    acc += delta;
    opts.onDelta?.(delta, acc);
  }
  return acc;
}
