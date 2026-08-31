import "./styles/index.css";

import { listModels, streamChat } from "./api/openai";
import { prepareAgentContext } from "./agent/context";
import { parseTrace, stripThink } from "./agent/parser";
import { runAgent, type AgentEvent } from "./agent/runner";
import { CODE_MODE_TOOL_NAME, TOOLS } from "./agent/tools";
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
import { buildRagSystemPrompt, formatRagContext } from "./rag/context";
import { RagRepository } from "./rag/repository";
import type { RagMatch } from "./rag/types";
import { SessionRepository, type SessionRecord } from "./sessions/repository";
import { SkillRepository } from "./skills/repository";
import { TrajectoryRepository } from "./trajectory/repository";
import type { ChatMessage, ConnectionState, ContentPart } from "./types";

import { createHeader } from "./ui/Header";
import { createChatView } from "./ui/ChatView";
import { createComposer } from "./ui/Composer";
import {
  createAgentMessage,
  createAssistantMessage,
  createSubAgentResultMessage,
  createUserMessage,
  createWorkflowMessage,
  formatSubAgentResult,
  parseSubAgentResult,
} from "./ui/Message";
import { createAgentTrace } from "./ui/AgentTrace";
import { createAgentManager } from "./ui/AgentManager";
import { createTaskWorkspace } from "./ui/TaskWorkspace";
import { createTrajectoryWorkspace } from "./ui/TrajectoryWorkspace";
import { createRagManager } from "./ui/RagManager";
import { createWorkflowWorkspace } from "./ui/WorkflowWorkspace";
import { h, loadPref, savePref } from "./ui/dom";
import { executeWorkflow, createWorkflowRun } from "./workflow/executor";
import { evaluateWorkflowForLearning, learnWorkflowTemplate } from "./workflow/learner";
import { planWorkflow } from "./workflow/planner";
import { WorkflowRepository } from "./workflow/repository";
import { WorkflowTemplateRepository } from "./workflow/templateRepository";

import { CHAT_TOKENS, DEFAULT_BASE_URL, STORAGE_KEYS } from "./config";

type AppState = {
  baseUrl: string;
  models: string[];
  currentModel: string;
  agentMode: boolean;
  flowEnabled: boolean;
  ragEnabled: boolean;
  sessionId: string;
  sessions: SessionRecord[];
  agentProfiles: AgentProfile[];
  agentTasks: AgentTask[];
  agentCount: number;
  memoryCount: number;
  ragCount: number;
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
  flowEnabled: loadPref(STORAGE_KEYS.flow, false),
  ragEnabled: loadPref(STORAGE_KEYS.rag, false),
  sessionId: initialSessionId,
  sessions: [],
  agentProfiles: [],
  agentTasks: [],
  agentCount: 0,
  memoryCount: 0,
  ragCount: 0,
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
const trajectoryRepository = new TrajectoryRepository();
const ragRepository = new RagRepository();
const workflowRepository = new WorkflowRepository();
const workflowTemplateRepository = new WorkflowTemplateRepository();
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
    if (!v) {
      state.flowEnabled = false;
      savePref(STORAGE_KEYS.flow, false);
    }
    savePref(STORAGE_KEYS.agent, v);
    if (v) state.attachments = [];
    render();
    void safePersistCurrentSession();
  },
  onFlowToggle(v) {
    state.flowEnabled = v;
    if (v) {
      state.agentMode = true;
      state.attachments = [];
      savePref(STORAGE_KEYS.agent, true);
    }
    savePref(STORAGE_KEYS.flow, v);
    render();
    setStatus("ok", v ? "Dynamic Flow 已开启" : "Dynamic Flow 已关闭");
  },
  onRagToggle(v) {
    state.ragEnabled = v;
    savePref(STORAGE_KEYS.rag, v);
    render();
    setStatus("ok", v ? "RAG 自动检索已开启" : "RAG 自动检索已关闭");
  },
  onRefresh: () => void refreshModels(),
  onSessionChange: (id) => void switchSession(id),
  onNewSession: () => void startNewSession(),
  onManageAgents: () => void manager.open("agents"),
  onManageMemory: () => void manager.open("memory"),
  onManageRag: () => void ragManager.open(),
  onManageSkills: () => void manager.open("skills"),
  onManageTrajectories: () => {
    taskWorkspace.close();
    workflowWorkspace.close();
    void trajectoryWorkspace.open(state.sessionId);
  },
  onManageWorkflows: () => {
    taskWorkspace.close();
    trajectoryWorkspace.close();
    void workflowWorkspace.open(state.sessionId);
  },
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
  [...Object.keys({ ...TOOLS, ...createMemoryTools(memoryRepository) }), CODE_MODE_TOOL_NAME],
  { onChanged: () => void refreshAgentMetadata() },
);
const taskWorkspace = createTaskWorkspace({
  onCancel: (taskId) => taskScheduler.cancel(taskId),
  onRemove: (taskId) => taskScheduler.remove(taskId),
  onClearFinished: () => taskScheduler.clearFinished(),
  onOpen: () => {
    trajectoryWorkspace.close();
    workflowWorkspace.close();
  },
});
const trajectoryWorkspace = createTrajectoryWorkspace(trajectoryRepository);
const ragManager = createRagManager(ragRepository, () => void refreshAgentMetadata());
const workflowWorkspace = createWorkflowWorkspace(
  workflowRepository,
  workflowTemplateRepository,
);
taskScheduler.subscribe((event) => {
  state.agentTasks = taskScheduler.listTasks();
  taskWorkspace.update(state.agentTasks, state.agentProfiles);
  if (event.type === "task-added") {
    trajectoryWorkspace.close();
    workflowWorkspace.close();
    taskWorkspace.open();
  }
  if (
    event.type === "task-updated"
    && event.task.status === "completed"
    && event.task.result
    && !event.task.workflowId
    && !publishedTaskIds.has(event.task.id)
  ) {
    publishedTaskIds.add(event.task.id);
    void publishSubAgentResult(event.task);
  }
});

root.append(
  header.el,
  chatView.el,
  composer.el,
  manager.el,
  taskWorkspace.el,
  trajectoryWorkspace.el,
  ragManager.el,
  workflowWorkspace.el,
);

function render() {
  header.update({
    baseUrl: state.baseUrl,
    models: state.models,
    currentModel: state.currentModel,
    agentMode: state.agentMode,
    flowEnabled: state.flowEnabled,
    ragEnabled: state.ragEnabled,
    sessionId: state.sessionId,
    sessions: state.sessions,
    agentCount: state.agentCount,
    memoryCount: state.memoryCount,
    ragCount: state.ragCount,
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
  state.agentMode = state.flowEnabled || session.agentMode;
  state.attachments = [];
  state.memoryCount = 0;
  savePref(STORAGE_KEYS.sessionId, session.id);
  savePref(STORAGE_KEYS.agent, session.agentMode);
  state.sessions = await sessionRepository.list();
  restoreHistory();
  render();
  void trajectoryWorkspace.refresh(session.id);
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
    const [memoryStats, ragStats, skills, agents] = await Promise.all([
      memoryRepository.stats(),
      ragRepository.stats(),
      skillRepository.list(),
      agentProfileRepository.list(),
    ]);
    state.memoryCount = memoryStats.total;
    state.ragCount = ragStats.documents;
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
  const trajectory = await trajectoryRepository.startRun(
    task.sessionId,
    {
      goal: task.goal,
      model,
      source: "sub-agent",
      agentName: profile.displayName,
    },
    task.id,
  );

  try {
    runtime.report({ phase: "context", message: "正在加载 Memory、Skills 和工具" });
    const context = await prepareAgentContext(
      task.goal,
      taskMemory,
      skillRepository,
      {
        skillIds: profile.skillIds,
        allowedTools: profile.allowedTools,
        ragRepository,
        ragEnabled: state.ragEnabled,
      },
    );
    let runtimeError: string | undefined;
    let lastStreamReportAt = 0;
    const onEvent = (event: AgentEvent) => {
      trajectory.append(event);
      if (event.type === "context") {
        runtime.report({
          phase: "context",
          message: `${event.skills.length} Skills · ${event.memories.length} Memory · ${event.ragMatches.length} RAG · ${event.tools.length} Tools`,
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
      } else if (event.type === "metrics") {
        runtime.report({
          phase: "streaming",
          message: `~${event.metrics.estimatedOutputTokens} tokens · ~${event.metrics.estimatedTokensPerSecond.toFixed(1)} tok/s`,
          step: event.metrics.steps,
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
    trajectory.finish("completed");
    if (state.sessionId === task.sessionId) void refreshAgentMetadata();
    return answer;
  } catch (error) {
    trajectory.finish(runtime.signal.aborted ? "cancelled" : "failed");
    throw error;
  } finally {
    await trajectory.flush();
    if (state.sessionId === task.sessionId) void trajectoryWorkspace.refresh(task.sessionId);
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
  if (state.flowEnabled) {
    if (attachments.length) {
      setStatus("bad", "Dynamic Flow 暂不支持图片附件");
      return;
    }
    await sendDynamicFlow(text);
  } else if (state.agentMode) await sendAgent(text);
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
    const ragMatches = await retrieveRag(text);
    const ragContext = formatRagContext(ragMatches);
    const messages: ChatMessage[] = ragContext
      ? [
          { role: "system", content: buildRagSystemPrompt(ragContext) },
          ...state.history,
        ]
      : state.history;
    accumulated = await streamChat(state.baseUrl, {
      model: state.currentModel,
      messages,
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
  let trajectory: Awaited<ReturnType<TrajectoryRepository["startRun"]>> | null = null;
  let trajectoryStatus: "completed" | "failed" | "cancelled" = "failed";

  const onEvent = (e: AgentEvent) => {
    trajectory?.append(e);
    trace.handleEvent(e, chatView.chatEl);
  };

  try {
    trajectory = await trajectoryRepository.startRun(state.sessionId, {
      goal: text,
      model: state.currentModel,
      source: "main",
    });
    const context = await prepareAgentContext(
      text,
      memoryRepository,
      skillRepository,
      {
        ragRepository,
        ragEnabled: state.ragEnabled,
      },
    );
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
      trajectoryStatus = "completed";
    } else if (currentController.signal.aborted) {
      trajectoryStatus = "cancelled";
    }
    setStatus("ok", "Agent 完成");
  } catch (err) {
    if (currentController?.signal.aborted) trajectoryStatus = "cancelled";
    setStatus("bad", "Agent 错误：" + (err as Error).message);
  } finally {
    trajectory?.finish(trajectoryStatus);
    await trajectory?.flush();
    void trajectoryWorkspace.refresh(state.sessionId);
    await safePersistCurrentSession();
    state.running = false;
    currentController = null;
    render();
  }
}

async function sendDynamicFlow(text: string) {
  state.history.push({ role: "user", content: text });
  chatView.addMessage(createUserMessage(text, []));
  state.running = true;
  const controller = new AbortController();
  currentController = controller;
  setStatus("ok", "Dynamic Flow 规划中…");
  await safePersistCurrentSession();

  const message = createWorkflowMessage();
  chatView.addMessage(message.el);
  try {
    setStatus("ok", "Dynamic Flow 正在召回相似模板…");
    const templateMatches = await workflowTemplateRepository.search(text, 3);
    setStatus(
      "ok",
      templateMatches.length
        ? `Dynamic Flow 命中 ${templateMatches.length} 个模板，正在规划…`
        : "Dynamic Flow 未命中模板，正在规划…",
    );
    const plan = await planWorkflow({
      baseUrl: state.baseUrl,
      model: state.currentModel,
      goal: text,
      agents: state.agentProfiles,
      templates: templateMatches,
      signal: controller.signal,
    });
    const run = createWorkflowRun({
      sessionId: state.sessionId,
      goal: text,
      model: state.currentModel,
      plan,
      templateMatches,
    });
    await workflowRepository.put(run);
    message.update(run);
    setStatus("ok", `Dynamic Flow 执行中 · ${run.nodes.length} 个节点`);

    const completed = await executeWorkflow({
      run,
      baseUrl: state.baseUrl,
      scheduler: taskScheduler,
      repository: workflowRepository,
      signal: controller.signal,
      onProgress: ({ run: current }) => {
        message.update(current);
        chatView.scrollToBottom();
        const done = current.nodes.filter((node) =>
          node.status === "completed"
          || node.status === "failed"
          || node.status === "skipped"
        ).length;
        setStatus("ok", `Dynamic Flow · ${done}/${current.nodes.length}`);
      },
    });
    const answer = stripThink(completed.finalAnswer ?? "").trim();
    if (!answer) throw new Error("Workflow did not produce a final answer");
    completed.finalAnswer = answer;
    await workflowRepository.put(completed);
    message.update(completed);

    setStatus("ok", "Dynamic Flow 正在评估可复用性…");
    const evaluation = await evaluateWorkflowForLearning({
      baseUrl: state.baseUrl,
      model: state.currentModel,
      run: completed,
      signal: controller.signal,
    });
    try {
      const learned = await learnWorkflowTemplate({
        run: completed,
        evaluation,
        agents: state.agentProfiles,
        repository: workflowTemplateRepository,
      });
      if (learned) {
        completed.learnedTemplateId = learned.id;
        completed.learnedTemplateName = learned.name;
      }
    } catch (learningError) {
      console.warn("Workflow template learning failed", learningError);
      completed.qualityScore = evaluation.score;
      completed.qualityReason = `模板保存失败：${
        learningError instanceof Error ? learningError.message : String(learningError)
      }`;
    }
    await workflowRepository.put(completed);
    message.update(completed);
    state.history.push({ role: "assistant", content: answer });
    await saveEpisode(text, answer);
    consolidateInBackground(text, answer);
    setStatus(
      completed.status === "completed" ? "ok" : "bad",
      completed.status === "completed" ? "Dynamic Flow 完成" : "Dynamic Flow 部分失败",
    );
  } catch (error) {
    const aborted = controller.signal.aborted || (error as Error).name === "AbortError";
    message.error(
      aborted ? "Dynamic Flow 已停止" : `Dynamic Flow 失败：${(error as Error).message}`,
      aborted,
    );
    setStatus(aborted ? "ok" : "bad", aborted ? "已停止" : "Dynamic Flow 失败");
  } finally {
    await workflowWorkspace.refresh(state.sessionId);
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
    state.agentMode = state.flowEnabled || session.agentMode;
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

async function retrieveRag(query: string): Promise<RagMatch[]> {
  if (!state.ragEnabled || !query.trim()) return [];
  try {
    setStatus("ok", "RAG 检索中…");
    return await ragRepository.search(query, 6);
  } catch (error) {
    console.warn("RAG retrieval failed", error);
    setStatus("bad", `RAG 检索失败，已继续生成：${(error as Error).message}`);
    return [];
  }
}

void boot();
