import "./styles/index.css";

import { listModels, streamChat } from "./api/openai";
import { prepareAgentContext } from "./agent/context";
import { runAgent, type AgentEvent } from "./agent/runner";
import { TOOLS } from "./agent/tools";
import { inferMemoryFromUserText } from "./memory/context";
import { consolidateConversation } from "./memory/consolidator";
import { MemoryRepository } from "./memory/repository";
import { createMemoryTools } from "./memory/tools";
import { SessionRepository, type SessionRecord } from "./sessions/repository";
import { SkillRepository } from "./skills/repository";
import type { ChatMessage, ConnectionState, ContentPart } from "./types";

import { createHeader } from "./ui/Header";
import { createChatView } from "./ui/ChatView";
import { createComposer } from "./ui/Composer";
import { createAgentMessage, createAssistantMessage, createUserMessage } from "./ui/Message";
import { createAgentTrace } from "./ui/AgentTrace";
import { createAgentManager } from "./ui/AgentManager";
import { h, loadPref, savePref } from "./ui/dom";

import { CHAT_TOKENS, DEFAULT_BASE_URL, STORAGE_KEYS } from "./config";

type AppState = {
  baseUrl: string;
  models: string[];
  currentModel: string;
  agentMode: boolean;
  sessionId: string;
  sessions: SessionRecord[];
  memoryCount: number;
  skillCount: number;
  status: { state: ConnectionState; text: string };
  running: boolean;
  attachments: string[];
  history: ChatMessage[];
};

function newSessionId(): string {
  return crypto.randomUUID?.() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sessionNamespace(sessionId: string): string {
  return `session/${sessionId}`;
}

const storedSessionId = loadPref(STORAGE_KEYS.sessionId, "");
const initialSessionId = storedSessionId || newSessionId();
if (!storedSessionId) savePref(STORAGE_KEYS.sessionId, initialSessionId);

const state: AppState = {
  baseUrl: loadPref(STORAGE_KEYS.baseUrl, DEFAULT_BASE_URL),
  models: [],
  currentModel: loadPref(STORAGE_KEYS.model, ""),
  agentMode: loadPref(STORAGE_KEYS.agent, false),
  sessionId: initialSessionId,
  sessions: [],
  memoryCount: 0,
  skillCount: 0,
  status: { state: "idle", text: "就绪" },
  running: false,
  attachments: [],
  history: [],
};

let currentController: AbortController | null = null;
let consolidationQueue = Promise.resolve();
const memoryRepository = new MemoryRepository(() => sessionNamespace(state.sessionId));
const sessionRepository = new SessionRepository();
const skillRepository = new SkillRepository();

// -------- UI wiring --------

const app = document.querySelector<HTMLDivElement>("#app")!;
const root = h("div", { className: "app" });
app.append(root);

const chatView = createChatView();
const header = createHeader({
  onBaseUrlChange(v) {
    state.baseUrl = v;
    savePref(STORAGE_KEYS.baseUrl, v);
    void refreshModels();
  },
  onModelChange(v) {
    state.currentModel = v;
    savePref(STORAGE_KEYS.model, v);
    render();
  },
  onAgentToggle(v) {
    state.agentMode = v;
    savePref(STORAGE_KEYS.agent, v);
    if (v) state.attachments = [];
    render();
    void safePersistCurrentSession();
  },
  onRefresh: () => void refreshModels(),
  onSessionChange: (id) => void switchSession(id),
  onNewSession: () => void startNewSession(),
  onManageMemory: () => void manager.open("memory"),
  onManageSkills: () => void manager.open("skills"),
});

const composer = createComposer({
  onSubmit: (text, attachments) => void send(text, attachments),
  onStop: () => currentController?.abort(),
  onFilesPicked: (files) => void addFiles(files),
  onRemoveAttachment(i) {
    state.attachments.splice(i, 1);
    render();
  },
});

const manager = createAgentManager(
  memoryRepository,
  skillRepository,
  Object.keys({ ...TOOLS, ...createMemoryTools(memoryRepository) }),
  { onChanged: () => void refreshAgentMetadata() },
);

root.append(header.el, chatView.el, composer.el, manager.el);

function render() {
  header.update({
    baseUrl: state.baseUrl,
    models: state.models,
    currentModel: state.currentModel,
    agentMode: state.agentMode,
    sessionId: state.sessionId,
    sessions: state.sessions,
    memoryCount: state.memoryCount,
    skillCount: state.skillCount,
    running: state.running,
    status: state.status,
  });
  composer.update({
    agentMode: state.agentMode,
    running: state.running,
    attachments: state.attachments,
  });
  chatView.setEmptyMode(state.agentMode);
}

function setStatus(stateName: ConnectionState, text: string) {
  state.status = { state: stateName, text };
  render();
}

async function startNewSession() {
  if (state.running) return;
  await safePersistCurrentSession();
  const session = await sessionRepository.create(newSessionId(), state.agentMode);
  await activateSession(session, "已创建隔离的新会话");
}

async function switchSession(id: string) {
  if (state.running || id === state.sessionId) return;
  await safePersistCurrentSession();
  const session = await sessionRepository.get(id);
  if (!session) {
    state.sessions = await sessionRepository.list();
    render();
    setStatus("bad", "会话不存在");
    return;
  }
  await activateSession(session, "已切换历史会话");
}

async function activateSession(session: SessionRecord, statusText: string) {
  state.sessionId = session.id;
  state.history = structuredClone(session.history);
  state.agentMode = session.agentMode;
  state.attachments = [];
  state.memoryCount = 0;
  savePref(STORAGE_KEYS.sessionId, session.id);
  savePref(STORAGE_KEYS.agent, session.agentMode);
  state.sessions = await sessionRepository.list();
  restoreHistory();
  render();
  await refreshAgentMetadata();
  setStatus("ok", statusText);
  composer.focus();
}

async function persistCurrentSession() {
  await sessionRepository.saveHistory(
    state.sessionId,
    state.history,
    state.agentMode,
  );
  state.sessions = await sessionRepository.list();
  render();
}

async function safePersistCurrentSession() {
  try {
    await persistCurrentSession();
  } catch (err) {
    console.warn("Session history save failed", err);
  }
}

function restoreHistory() {
  chatView.clear();
  for (const message of state.history) {
    if (message.role === "user") {
      const text = typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.type === "text" ? part.text : "")
            .join("\n");
      const images = typeof message.content === "string"
        ? []
        : message.content
            .filter((part) => part.type === "image_url")
            .map((part) => part.type === "image_url" ? part.image_url.url : "");
      chatView.addMessage(createUserMessage(text, images));
    } else if (message.role === "assistant") {
      const assistant = createAssistantMessage();
      assistant.update(
        typeof message.content === "string" ? message.content : "",
        false,
      );
      assistant.done();
      chatView.addMessage(assistant.el);
    }
  }
}

// -------- Data flow --------

async function refreshModels() {
  setStatus("idle", "连接中…");
  try {
    const ids = await listModels(state.baseUrl);
    state.models = ids;
    if (!ids.length) {
      state.currentModel = "";
      setStatus("bad", "无可用模型");
      return;
    }
    if (!state.currentModel || !ids.includes(state.currentModel)) {
      state.currentModel = ids[0]!;
      savePref(STORAGE_KEYS.model, state.currentModel);
    }
    setStatus("ok", `已连接 · ${ids.length} 个模型`);
  } catch (err) {
    state.models = [];
    state.currentModel = "";
    setStatus("bad", "连接失败：" + (err as Error).message);
  }
}

async function refreshAgentMetadata() {
  try {
    const [memoryStats, skills] = await Promise.all([
      memoryRepository.stats(),
      skillRepository.list(),
    ]);
    state.memoryCount = memoryStats.total;
    state.skillCount = skills.filter((skill) => skill.enabled).length;
    render();
  } catch (err) {
    console.error("Agent metadata load failed", err);
  }
}

async function rememberExplicitUserInput(text: string) {
  const inferred = inferMemoryFromUserText(text);
  if (!inferred) return;
  const existing = await memoryRepository.list();
  if (existing.some((record) => record.content === inferred.content)) return;
  await memoryRepository.save(inferred);
  await refreshAgentMetadata();
}

async function saveEpisode(goal: string, answer: string) {
  try {
    const content = `Task: ${goal}\nAnswer: ${answer}`.slice(0, 6000);
    await memoryRepository.save({
      kind: "episode",
      title: goal.slice(0, 120) || "Conversation",
      content,
      tags: ["conversation"],
      importance: 0.55,
      source: "agent",
    });
    const episodes = (await memoryRepository.list()).filter((record) => record.kind === "episode");
    await Promise.all(episodes.slice(200).map((record) => memoryRepository.remove(record.id)));
    await refreshAgentMetadata();
  } catch (err) {
    console.warn("Episode memory save failed", err);
  }
}

function consolidateInBackground(userText: string, assistantText: string) {
  const baseUrl = state.baseUrl;
  const model = state.currentModel;
  const capturedSessionId = state.sessionId;
  const sessionMemory = new MemoryRepository(
    () => sessionNamespace(capturedSessionId),
  );
  consolidationQueue = consolidationQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        const count = await consolidateConversation({
          baseUrl,
          model,
          userText,
          assistantText,
          memory: sessionMemory,
        });
        if (count && state.sessionId === capturedSessionId) await refreshAgentMetadata();
      } catch (err) {
        console.warn("Background memory consolidation failed", err);
      }
    });
}

async function addFiles(files: File[]) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    const dataUrl = await fileToDataUrl(f);
    state.attachments.push(dataUrl);
  }
  render();
}

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(f);
  });
}

async function send(text: string, attachments: string[]) {
  if (!state.currentModel) {
    setStatus("bad", "请先选择模型");
    return;
  }
  try {
    await rememberExplicitUserInput(text);
  } catch (err) {
    console.warn("Explicit memory save failed", err);
  }
  if (state.agentMode) await sendAgent(text);
  else await sendChat(text, attachments);
}

async function sendChat(text: string, attachments: string[]) {
  const content: string | ContentPart[] = attachments.length
    ? [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...attachments.map((url) => ({ type: "image_url" as const, image_url: { url } })),
      ]
    : text;

  state.history.push({ role: "user", content });
  chatView.addMessage(createUserMessage(text, attachments));

  state.attachments = [];
  state.running = true;
  currentController = new AbortController();
  setStatus("ok", "生成中…");
  await safePersistCurrentSession();

  const assistant = createAssistantMessage();
  chatView.addMessage(assistant.el);

  let accumulated = "";
  try {
    accumulated = await streamChat(state.baseUrl, {
      model: state.currentModel,
      messages: state.history,
      temperature: 0.7,
      maxTokens: CHAT_TOKENS,
      signal: currentController.signal,
      onDelta: (_d, cur) => {
        accumulated = cur;
        assistant.update(cur, true);
        chatView.scrollToBottom();
      },
    });
    assistant.update(accumulated, false);
    assistant.done();
    state.history.push({ role: "assistant", content: accumulated });
    await saveEpisode(text, accumulated);
    consolidateInBackground(text, accumulated);
    setStatus("ok", "完成");
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError") {
      assistant.done();
      if (accumulated) state.history.push({ role: "assistant", content: accumulated });
      setStatus("ok", "已停止");
    } else {
      assistant.error("请求失败：" + e.message);
      state.history.pop();
      setStatus("bad", "请求失败");
    }
  } finally {
    await safePersistCurrentSession();
    state.running = false;
    currentController = null;
    render();
  }
}

async function sendAgent(text: string) {
  state.history.push({ role: "user", content: text });
  chatView.addMessage(createUserMessage(text, []));

  state.running = true;
  currentController = new AbortController();
  setStatus("ok", "Agent 运行中…");
  await safePersistCurrentSession();

  const agent = createAgentMessage();
  chatView.addMessage(agent.el);
  const trace = createAgentTrace(agent.traceHost);

  const onEvent = (e: AgentEvent) => {
    trace.handleEvent(e, chatView.chatEl);
  };

  try {
    const context = await prepareAgentContext(text, memoryRepository, skillRepository);
    const answer = await runAgent({
      baseUrl: state.baseUrl,
      model: state.currentModel,
      goal: text,
      ...context,
      signal: currentController.signal,
      onEvent,
    });
    if (answer) {
      state.history.push({ role: "assistant", content: answer });
      await saveEpisode(text, answer);
      consolidateInBackground(text, answer);
    }
    setStatus("ok", "Agent 完成");
  } catch (err) {
    setStatus("bad", "Agent 错误：" + (err as Error).message);
  } finally {
    await safePersistCurrentSession();
    state.running = false;
    currentController = null;
    render();
  }
}

// -------- Boot --------

async function boot() {
  try {
    const session = await sessionRepository.ensure(state.sessionId, state.agentMode);
    state.history = structuredClone(session.history);
    state.agentMode = session.agentMode;
    state.sessions = await sessionRepository.list();
    restoreHistory();
  } catch (err) {
    console.error("Session load failed", err);
    setStatus("bad", "会话历史加载失败");
  }
  render();
  composer.focus();
  void refreshModels();
  void refreshAgentMetadata();
}

void boot();
