import "./styles/index.css";

import { listModels, streamChat } from "./api/openai";
import { prepareAgentContext } from "./agent/context";
import { parseTrace } from "./agent/parser";
import { runAgent, type AgentEvent } from "./agent/runner";
import { TOOLS } from "./agent/tools";
import { parseAgentMention } from "./agents/mention-parser";
import { AgentProfileRepository } from "./agents/repository";
import { AgentTaskScheduler } from "./agents/scheduler";
import type {
  AgentProfile,
  AgentTask,
  AgentTaskRunnerContext,
} from "./agents/types";
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
import {
  createAgentMessage,
  createAssistantMessage,
  createSubAgentResultMessage,
  createUserMessage,
  formatSubAgentResult,
  parseSubAgentResult,
} from "./ui/Message";
import { createAgentTrace } from "./ui/AgentTrace";
import { createAgentManager } from "./ui/AgentManager";
import { createTaskWorkspace } from "./ui/TaskWorkspace";
import { h, loadPref, savePref } from "./ui/dom";

import { CHAT_TOKENS, DEFAULT_BASE_URL, STORAGE_KEYS } from "./config";

type AppState = {
  baseUrl: string;
  models: string[];
  currentModel: string;
  agentMode: boolean;
  sessionId: string;
  sessions: SessionRecord[];
  agentProfiles: AgentProfile[];
  agentTasks: AgentTask[];
  agentCount: number;
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
  agentProfiles: [],
  agentTasks: [],
  agentCount: 0,
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
const agentProfileRepository = new AgentProfileRepository();
const taskScheduler = new AgentTaskScheduler({
  maxConcurrency: 3,
  runner: runScheduledAgentTask,
});
const publishedTaskIds = new Set<string>();

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
  onManageAgents: () => void manager.open("agents"),
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
  agentProfileRepository,
  Object.keys({ ...TOOLS, ...createMemoryTools(memoryRepository) }),
  { onChanged: () => void refreshAgentMetadata() },
);
const taskWorkspace = createTaskWorkspace({
  onCancel: (taskId) => taskScheduler.cancel(taskId),
  onRemove: (taskId) => taskScheduler.remove(taskId),
  onClearFinished: () => taskScheduler.clearFinished(),
});
taskScheduler.subscribe((event) => {
  state.agentTasks = taskScheduler.listTasks();
  taskWorkspace.update(state.agentTasks, state.agentProfiles);
  if (event.type === "task-added") taskWorkspace.open();
  if (
    event.type === "task-updated"
    && event.task.status === "completed"
    && event.task.result
    && !publishedTaskIds.has(event.task.id)
  ) {
    publishedTaskIds.add(event.task.id);
    void publishSubAgentResult(event.task);
  }
});

root.append(header.el, chatView.el, composer.el, manager.el, taskWorkspace.el);

function render() {
  header.update({
    baseUrl: state.baseUrl,
    models: state.models,
    currentModel: state.currentModel,
    agentMode: state.agentMode,
    sessionId: state.sessionId,
    sessions: state.sessions,
    agentCount: state.agentCount,
    memoryCount: state.memoryCount,
    skillCount: state.skillCount,
    running: state.running,
    status: state.status,
  });
  composer.update({
    agentMode: state.agentMode,
    running: state.running,
    attachments: state.attachments,
    agentProfiles: state.agentProfiles,
  });
  chatView.setEmptyMode(state.agentMode);
  taskWorkspace.update(state.agentTasks, state.agentProfiles);
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

async function publishSubAgentResult(task: AgentTask) {
  try {
    const profile = state.agentProfiles.find((entry) => entry.id === task.agentId)
      ?? (await agentProfileRepository.list()).find((entry) => entry.id === task.agentId);
    const result = {
      agentName: profile?.displayName ?? task.agentId,
      goal: task.goal,
      answer: task.result ?? "",
    };
    const message: ChatMessage = {
      role: "assistant",
      content: formatSubAgentResult(result),
    };

    if (state.sessionId === task.sessionId) {
      state.history.push(message);
      chatView.addMessage(createSubAgentResultMessage(result));
      chatView.scrollToBottom();
      const history = structuredClone(state.history);
      const agentMode = state.agentMode;
      await sessionRepository.saveHistory(task.sessionId, history, agentMode);
    } else {
      await sessionRepository.appendMessage(task.sessionId, message);
    }
    state.sessions = await sessionRepository.list();
    render();
  } catch (error) {
    console.error("Sub-Agent result publish failed", error);
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
      const raw = typeof message.content === "string" ? message.content : "";
      const subAgentResult = parseSubAgentResult(raw);
      if (subAgentResult) {
        chatView.addMessage(createSubAgentResultMessage(subAgentResult));
        continue;
      }
      const assistant = createAssistantMessage();
      assistant.update(raw, false);
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
    const [memoryStats, skills, agents] = await Promise.all([
      memoryRepository.stats(),
      skillRepository.list(),
      agentProfileRepository.list(),
    ]);
    state.memoryCount = memoryStats.total;
    state.skillCount = skills.filter((skill) => skill.enabled).length;
    state.agentProfiles = agents;
    state.agentCount = agents.filter((agent) => agent.enabled).length;
    render();
  } catch (err) {
    console.error("Agent metadata load failed", err);
  }
}

function abortError(): Error {
  const error = new Error("Task aborted");
  error.name = "AbortError";
  return error;
}

async function runScheduledAgentTask(
  task: Readonly<AgentTask>,
  runtime: AgentTaskRunnerContext,
): Promise<string | null> {
  const profile = (await agentProfileRepository.list()).find(
    (entry) => entry.id === task.agentId && entry.enabled,
  );
  if (!profile) throw new Error(`Agent role is unavailable: ${task.agentId}`);
  const model = profile.model || state.currentModel;
  if (!model) throw new Error("No model selected for this Agent");
  const baseUrl = state.baseUrl;
  const taskMemory = new MemoryRepository(() => sessionNamespace(task.sessionId));

  runtime.report({ phase: "context", message: "正在加载 Memory、Skills 和工具" });
  const context = await prepareAgentContext(
    task.goal,
    taskMemory,
    skillRepository,
    {
      skillIds: profile.skillIds,
      allowedTools: profile.allowedTools,
    },
  );
  let runtimeError: string | undefined;
  let lastStreamReportAt = 0;
  const onEvent = (event: AgentEvent) => {
    if (event.type === "context") {
      runtime.report({
        phase: "context",
        message: `${event.skills.length} Skills · ${event.memories.length} Memory · ${event.tools.length} Tools`,
      });
    } else if (event.type === "step-start") {
      runtime.report({
        phase: "thinking",
        message: "模型正在生成下一步动作",
        step: event.step + 1,
        totalSteps: profile.maxSteps,
      });
    } else if (event.type === "stream") {
      const now = performance.now();
      if (now - lastStreamReportAt >= 1000) {
        lastStreamReportAt = now;
        runtime.report({
          phase: "streaming",
          message: `已接收 ${event.trace.length} 个字符`,
          step: event.step + 1,
          totalSteps: profile.maxSteps,
        });
      }
    } else if (event.type === "observation") {
      const action = parseTrace(event.trace)
        .filter((block) => block.kind === "action")
        .at(-1)?.text.trim();
      runtime.report({
        phase: "tool",
        message: action ? `工具已完成：${action}` : "已收到工具结果",
        step: event.step + 1,
        totalSteps: profile.maxSteps,
      });
    } else if (event.type === "final") {
      runtime.report({ phase: "final", message: "最终答案已生成" });
    } else if (event.type === "max-steps") {
      runtimeError = "Agent 已达到最大执行步数";
    } else if (event.type === "error") {
      runtimeError = event.message;
    }
  };

  const answer = await runAgent({
    baseUrl,
    model,
    goal: task.goal,
    ...context,
    rolePrompt: profile.rolePrompt,
    maxSteps: profile.maxSteps,
    signal: runtime.signal,
    onEvent,
  });
  if (runtime.signal.aborted) throw abortError();
  if (runtimeError) throw new Error(runtimeError);
  if (!answer) throw new Error("Agent did not produce a final answer");

  await taskMemory.save({
    kind: "episode",
    title: `[${profile.displayName}] ${task.goal}`.slice(0, 160),
    content: `Task: ${task.goal}\nAnswer: ${answer}`.slice(0, 6000),
    tags: ["conversation", "sub-agent", profile.name],
    importance: 0.55,
    source: "agent",
    scope: "agent",
  });
  if (state.sessionId === task.sessionId) void refreshAgentMetadata();
  return answer;
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
  const mention = parseAgentMention(text, state.agentProfiles);
  if (mention.kind === "unknown") {
    setStatus("bad", `未找到角色 ${mention.mention || "@?"}`);
    return;
  }
  if (mention.kind === "matched") {
    if (!mention.goal) {
      setStatus("bad", `请在 ${mention.mention} 后输入任务`);
      return;
    }
    if (attachments.length) {
      setStatus("bad", "子 Agent 任务暂不支持图片附件");
      return;
    }
    const model = mention.profile.model || state.currentModel;
    if (!model) {
      setStatus("bad", "请先选择模型，或为角色指定模型");
      return;
    }
    taskScheduler.submit({
      sessionId: state.sessionId,
      agentId: mention.profile.id,
      goal: mention.goal,
    });
    setStatus("ok", `已提交给 ${mention.profile.displayName}`);
    return;
  }
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
