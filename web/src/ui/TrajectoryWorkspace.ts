import type { AgentEvent } from "../agent/runner";
import type { TrajectoryRepository } from "../trajectory/repository";
import type { TrajectoryEntry, TrajectoryRun } from "../trajectory/types";
import { createAgentTrace } from "./AgentTrace";
import { h } from "./dom";

const STATUS_LABEL: Record<TrajectoryRun["status"], string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function isAgentEvent(entry: TrajectoryEntry): entry is TrajectoryEntry & { event: AgentEvent } {
  return entry.event.type !== "run-start" && entry.event.type !== "run-end";
}

function duration(run: TrajectoryRun): string {
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function createTrajectoryWorkspace(repository: TrajectoryRepository) {
  let sessionId = "";
  let runs: TrajectoryRun[] = [];
  let selectedRunId = "";
  let replayVersion = 0;

  const list = h("div", { className: "trajectory-workspace__list" });
  const detail = h("div", { className: "trajectory-workspace__detail" });
  const traceHost = h("div", { className: "trajectory-workspace__trace" });
  const trace = createAgentTrace(traceHost);
  const title = h("strong", {}, "Trajectory");
  const count = h("span", { className: "trajectory-workspace__count" }, "0");
  const replay = h("button", { className: "trajectory-workspace__action" }, "回放");
  replay.disabled = true;
  replay.addEventListener("click", () => void replaySelected());
  const close = h(
    "button",
    { className: "trajectory-workspace__close", title: "关闭 Trajectory" },
    "×",
  );
  const panel = h(
    "aside",
    { className: "trajectory-workspace" },
    h(
      "header",
      { className: "trajectory-workspace__header" },
      title,
      count,
      replay,
      close,
    ),
    h("div", { className: "trajectory-workspace__body" }, list, detail),
  );
  close.addEventListener("click", () => setOpen(false));

  function setOpen(opened: boolean) {
    panel.classList.toggle("is-open", opened);
    if (!opened) replayVersion++;
  }

  async function load(nextSessionId = sessionId) {
    sessionId = nextSessionId;
    runs = sessionId ? await repository.listRuns(sessionId) : [];
    count.textContent = String(runs.length);
    if (!runs.some((run) => run.runId === selectedRunId)) {
      selectedRunId = runs[0]?.runId ?? "";
    }
    renderList();
    if (selectedRunId) await showRun(selectedRunId);
    else {
      replay.disabled = true;
      detail.replaceChildren(
        h("div", { className: "trajectory-workspace__empty" }, "当前会话暂无 Agent Trajectory。"),
      );
    }
  }

  function renderList() {
    list.replaceChildren();
    for (const run of runs) {
      const item = h(
        "button",
        {
          className: `trajectory-run${run.runId === selectedRunId ? " is-active" : ""}`,
          title: run.goal,
        },
        h(
          "span",
          { className: "trajectory-run__head" },
          h("strong", {}, run.agentName ?? (run.source === "main" ? "Main Agent" : "Sub-Agent")),
          h("span", {}, STATUS_LABEL[run.status]),
        ),
        h("span", { className: "trajectory-run__goal" }, run.goal),
        h(
          "span",
          { className: "trajectory-run__meta" },
          `${duration(run)} · ${run.eventCount} events`,
        ),
      );
      item.addEventListener("click", () => void showRun(run.runId));
      list.append(item);
    }
  }

  async function showRun(runId: string) {
    replayVersion++;
    selectedRunId = runId;
    renderList();
    replay.disabled = false;
    const entries = await repository.getEntries(runId);
    trace.reset();
    detail.replaceChildren(traceHost);
    for (const entry of entries) {
      if (isAgentEvent(entry)) trace.handleEvent(entry.event);
    }
  }

  async function replaySelected() {
    if (!selectedRunId) return;
    const version = ++replayVersion;
    const entries = await repository.getEntries(selectedRunId);
    trace.reset();
    detail.replaceChildren(traceHost);
    replay.disabled = true;
    for (const entry of entries) {
      if (version !== replayVersion) return;
      if (!isAgentEvent(entry)) continue;
      trace.handleEvent(entry.event);
      await new Promise((resolve) => window.setTimeout(resolve, 140));
    }
    if (version === replayVersion) replay.disabled = false;
  }

  return {
    el: panel,
    async open(nextSessionId: string) {
      setOpen(true);
      await load(nextSessionId);
    },
    close: () => setOpen(false),
    refresh: (nextSessionId: string) => load(nextSessionId),
  };
}
