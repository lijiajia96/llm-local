import type { AgentProfile, AgentTask, AgentTaskStatus } from "../agents/types";
import { h } from "./dom";

export type TaskWorkspaceCallbacks = {
  onCancel: (taskId: string) => void;
  onRemove: (taskId: string) => void;
  onClearFinished: () => void;
  onOpen?: () => void;
};

const STATUS_LABEL: Record<AgentTaskStatus, string> = {
  queued: "排队中",
  running: "运行中",
  cancelling: "停止中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const PHASE_LABEL: Record<string, string> = {
  starting: "启动任务",
  context: "准备上下文",
  thinking: "模型思考",
  streaming: "持续生成",
  tool: "调用工具",
  final: "生成答案",
  completed: "任务完成",
  failed: "任务失败",
  cancelling: "正在停止",
  cancelled: "已取消",
};

function isActive(task: AgentTask): boolean {
  return task.status === "queued"
    || task.status === "running"
    || task.status === "cancelling";
}

function duration(task: AgentTask, now = Date.now()): string {
  const start = Date.parse(task.startedAt ?? task.createdAt);
  const end = task.finishedAt
    ? Date.parse(task.finishedAt)
    : isActive(task)
      ? now
      : Date.parse(task.updatedAt);
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function progressText(task: AgentTask, now = Date.now()): string {
  const latest = task.events[task.events.length - 1];
  const phase = PHASE_LABEL[latest?.phase ?? ""] ?? latest?.phase ?? "";
  const step = latest?.step != null
    ? `Step ${latest.step}/${latest.totalSteps ?? "?"}`
    : phase;
  const detail = latest?.message ? ` · ${latest.message}` : "";
  const idleSeconds = Math.max(0, Math.floor((now - Date.parse(task.updatedAt)) / 1000));
  const stalled = task.status === "running" && idleSeconds >= 15
    ? ` · ${idleSeconds}s 无新输出`
    : "";
  return `${step}${latest?.step != null && phase ? ` · ${phase}` : ""}${detail}${stalled}`;
}

export function createTaskWorkspace(cb: TaskWorkspaceCallbacks) {
  let tasks: AgentTask[] = [];
  let profiles: AgentProfile[] = [];
  let opened = false;

  const count = h("span", { className: "task-workspace__count" }, "0");
  const activeCount = h("span", { className: "task-workspace__active" }, "");
  const list = h("div", { className: "task-workspace__list" });
  const clear = h("button", { className: "task-workspace__clear" }, "清理已完成");
  clear.addEventListener("click", cb.onClearFinished);
  const close = h("button", { className: "task-workspace__close", title: "收起任务面板" }, "×");
  close.addEventListener("click", () => setOpen(false));

  const panel = h(
    "aside",
    { className: "task-workspace" },
    h(
      "header",
      { className: "task-workspace__header" },
      h("div", {}, h("strong", {}, "子 Agent 任务 "), count, activeCount),
      clear,
      close,
    ),
    list,
  );
  const launcher = h(
    "button",
    { className: "task-workspace__launcher", title: "查看子 Agent 任务" },
    "Tasks ",
    h("span", {}, "0"),
  );
  launcher.addEventListener("click", () => {
    cb.onOpen?.();
    setOpen(true);
  });
  const el = h("div", { className: "task-workspace-host" }, panel, launcher);

  function setOpen(value: boolean) {
    opened = value;
    panel.classList.toggle("is-open", opened);
    launcher.hidden = opened;
  }

  function render() {
    const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
    const running = tasks.filter(isActive).length;
    count.textContent = String(tasks.length);
    activeCount.textContent = running ? ` · ${running} 运行中` : "";
    launcher.querySelector("span")!.textContent = running ? String(running) : String(tasks.length);
    clear.disabled = !tasks.some((task) => !isActive(task));
    list.replaceChildren();
    if (!tasks.length) {
      list.append(
        h(
          "div",
          { className: "task-workspace__empty" },
          "在主输入框使用 @角色 提交任务，运行状态会显示在这里。",
        ),
      );
      return;
    }
    for (const task of tasks) {
      list.append(taskCard(task, profileMap.get(task.agentId)));
    }
  }

  function refreshActiveIndicators() {
    const now = Date.now();
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    for (const card of list.querySelectorAll<HTMLElement>("[data-task-id]")) {
      const task = taskMap.get(card.dataset.taskId ?? "");
      if (!task || !isActive(task)) continue;
      const durationEl = card.querySelector<HTMLElement>('[data-role="duration"]');
      const progressEl = card.querySelector<HTMLElement>('[data-role="progress"]');
      if (durationEl) durationEl.textContent = duration(task, now);
      if (progressEl) progressEl.textContent = progressText(task, now);
    }
  }

  function taskCard(task: AgentTask, profile?: AgentProfile) {
    const latest = task.events[task.events.length - 1];
    const action = h(
      "button",
      { className: `task-card__action${isActive(task) ? " danger" : ""}` },
      isActive(task) ? "停止" : "移除",
    );
    action.addEventListener("click", () => {
      if (isActive(task)) cb.onCancel(task.id);
      else cb.onRemove(task.id);
    });
    const visibleEvents = task.events.filter((event, index, all) =>
      event.phase !== "streaming"
      || !all.slice(index + 1).some((entry) => entry.phase === "streaming"),
    );
    const events = h("div", { className: "task-card__events" });
    for (const event of visibleEvents.slice(-8)) {
      events.append(
        h(
          "div",
          { className: "task-card__event" },
          h("span", {}, event.step != null ? `${event.step}` : "·"),
          h("strong", {}, PHASE_LABEL[event.phase] ?? event.phase),
          h("span", {}, event.message ?? ""),
        ),
      );
    }
    return h(
      "article",
      {
        className: `task-card task-card--${task.status}`,
        dataset: { taskId: task.id },
      },
      h(
        "div",
        { className: "task-card__head" },
        h("span", { className: "task-card__role" }, profile?.displayName ?? task.agentId),
        task.workflowNodeId
          ? h("span", { className: "task-card__flow" }, `Flow · ${task.workflowNodeId}`)
          : "",
        h("span", { className: "task-card__status" }, STATUS_LABEL[task.status]),
        h(
          "span",
          { className: "task-card__duration", dataset: { role: "duration" } },
          duration(task),
        ),
        action,
      ),
      h(
        "div",
        { className: "task-card__goal" },
        task.workflowId ? task.goal.split("\n\nUse these completed upstream")[0]! : task.goal,
      ),
      task.dependsOn?.length
        ? h("div", { className: "task-card__deps" }, `依赖：${task.dependsOn.join(", ")}`)
        : "",
      latest
        ? h(
            "div",
            { className: "task-card__progress", dataset: { role: "progress" } },
            progressText(task),
          )
        : "",
      task.result
        ? h("div", { className: "task-card__result" }, task.result)
        : task.error
          ? h("div", { className: "task-card__error" }, task.error)
          : "",
      task.events.length
        ? h("details", { className: "task-card__details" }, h("summary", {}, "运行记录"), events)
        : "",
    );
  }

  render();
  setOpen(false);
  window.setInterval(refreshActiveIndicators, 1000);
  return {
    el,
    open: () => setOpen(true),
    close: () => setOpen(false),
    update(nextTasks: AgentTask[], nextProfiles: AgentProfile[]) {
      tasks = nextTasks;
      profiles = nextProfiles;
      render();
    },
  };
}
