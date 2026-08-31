export const DEFAULT_BASE_URL =
  import.meta.env.VITE_VLLM_BASE_URL?.trim() || "http://127.0.0.1:8000/v1";

export const AGENT_MAX_STEPS = 8;
export const AGENT_STEP_TOKENS = 1200;
export const CHAT_TOKENS = 2048;
export const TOOL_TIMEOUT_MS = 25_000;

export const STORAGE_KEYS = {
  baseUrl: "vllm.baseUrl",
  model: "vllm.model",
  agent: "vllm.agentMode",
  rag: "vllm.ragEnabled",
  sessionId: "vllm.sessionId",
} as const;
