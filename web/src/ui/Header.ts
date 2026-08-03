import type { ConnectionState } from "../types";
import { h } from "./dom";

export type HeaderModel = {
  baseUrl: string;
  models: string[];
  currentModel: string;
  agentMode: boolean;
  sessionId: string;
  sessions: Array<{ id: string; title: string }>;
  agentCount: number;
  memoryCount: number;
  skillCount: number;
  running: boolean;
  status: { state: ConnectionState; text: string };
};

export type HeaderCallbacks = {
  onBaseUrlChange: (v: string) => void;
  onModelChange: (v: string) => void;
  onAgentToggle: (v: boolean) => void;
  onRefresh: () => void;
  onSessionChange: (id: string) => void;
  onNewSession: () => void;
  onManageAgents: () => void;
  onManageMemory: () => void;
  onManageSkills: () => void;
};

export function createHeader(cb: HeaderCallbacks) {
  const dot = h("span", { className: "status-dot" });
  const urlInput = h("input", {
    className: "url-input",
    type: "text",
    placeholder: "http://host:8000/v1",
    spellcheck: false,
  }) as HTMLInputElement;
  urlInput.addEventListener("change", () => cb.onBaseUrlChange(urlInput.value.trim()));

  const modelSelect = h("select", { className: "model-select" }) as HTMLSelectElement;
  modelSelect.addEventListener("change", () => cb.onModelChange(modelSelect.value));

  const refreshBtn = h(
    "button",
    { className: "icon-btn ghost", title: "重新连接并刷新模型列表", onClick: cb.onRefresh },
    "↻",
  );

  const agentInput = h("input", { type: "checkbox" }) as HTMLInputElement;
  agentInput.addEventListener("change", () => cb.onAgentToggle(agentInput.checked));
  const agentToggle = h(
    "label",
    { className: "switch", title: "开启后模型会以 ReAct 循环调用工具" },
    agentInput,
    h("span", { className: "switch-track" }, h("span", { className: "switch-thumb" })),
    h("span", { className: "switch-label" }, "Agent 模式"),
  );

  const sessionSelect = h(
    "select",
    { className: "session-select", title: "切换历史会话" },
  ) as HTMLSelectElement;
  sessionSelect.addEventListener("change", () => cb.onSessionChange(sessionSelect.value));

  const sessionBtn = h(
    "button",
    { className: "icon-btn ghost", title: "创建隔离的新会话", onClick: cb.onNewSession },
    h("span", {}, "＋ 新会话"),
  );
  const agentsBtn = h(
    "button",
    { className: "icon-btn ghost", title: "创建和管理 Agent 角色", onClick: cb.onManageAgents },
    "Agents ",
    h("span", { className: "header-count", dataset: { role: "agent-count" } }, "0"),
  );
  const memoryBtn = h(
    "button",
    { className: "icon-btn ghost", title: "管理长期记忆", onClick: cb.onManageMemory },
    "Memory ",
    h("span", { className: "header-count", dataset: { role: "memory-count" } }, "0"),
  );
  const skillsBtn = h(
    "button",
    { className: "icon-btn ghost", title: "管理 Agent Skills", onClick: cb.onManageSkills },
    "Skills ",
    h("span", { className: "header-count", dataset: { role: "skill-count" } }, "0"),
  );

  const statusText = h("span", { className: "status-text" });

  const el = h(
    "header",
    { className: "app-header" },
    h(
      "div",
      { className: "app-header__brand" },
      h("span", { className: "brand-mark" }),
      h("span", { className: "brand-title" }, "vLLM Chat"),
    ),
    h(
      "div",
      { className: "app-header__connection" },
      dot,
      urlInput,
      modelSelect,
      refreshBtn,
      statusText,
    ),
    h(
      "div",
      { className: "app-header__actions" },
      sessionSelect,
      sessionBtn,
      agentsBtn,
      memoryBtn,
      skillsBtn,
      agentToggle,
    ),
  );

  function update(m: HeaderModel) {
    if (urlInput.value !== m.baseUrl) urlInput.value = m.baseUrl;
    // repopulate model options only if the set differs
    const optIds = Array.from(modelSelect.options).map((o) => o.value);
    const same = optIds.length === m.models.length && optIds.every((v, i) => v === m.models[i]);
    if (!same) {
      modelSelect.innerHTML = "";
      if (!m.models.length) {
        modelSelect.append(h("option", { value: "" }, "无可用模型"));
      } else {
        for (const id of m.models) modelSelect.append(h("option", { value: id }, id));
      }
    }
    modelSelect.value = m.currentModel;
    agentInput.checked = m.agentMode;
    const sessionSignature = m.sessions.map((session) => `${session.id}:${session.title}`).join("|");
    if (sessionSelect.dataset.signature !== sessionSignature) {
      sessionSelect.replaceChildren(
        ...m.sessions.map((session) =>
          h("option", { value: session.id }, `${session.title} · ${session.id.slice(0, 8)}`),
        ),
      );
      sessionSelect.dataset.signature = sessionSignature;
    }
    sessionSelect.value = m.sessionId;
    sessionSelect.disabled = m.running;
    sessionBtn.disabled = m.running;
    const agentCount = el.querySelector<HTMLElement>('[data-role="agent-count"]')!;
    const memoryCount = el.querySelector<HTMLElement>('[data-role="memory-count"]')!;
    const skillCount = el.querySelector<HTMLElement>('[data-role="skill-count"]')!;
    agentCount.textContent = String(m.agentCount);
    memoryCount.textContent = String(m.memoryCount);
    skillCount.textContent = String(m.skillCount);
    dot.dataset.state = m.status.state;
    statusText.textContent = m.status.text;
  }

  return { el, update };
}

export type HeaderApi = ReturnType<typeof createHeader>;
