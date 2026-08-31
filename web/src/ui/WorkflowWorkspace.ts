import type { WorkflowRepository } from "../workflow/repository";
import type { WorkflowTemplateRepository } from "../workflow/templateRepository";
import type { WorkflowRun, WorkflowTemplate } from "../workflow/types";
import { h } from "./dom";
import { renderMarkdown } from "./markdown";

const STATUS_LABEL: Record<WorkflowRun["status"], string> = {
  planning: "规划中",
  running: "执行中",
  interrupted: "待恢复",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export type WorkflowWorkspaceCallbacks = {
  onResume: (runId: string) => void;
};

export function createWorkflowWorkspace(
  repository: WorkflowRepository,
  templateRepository: WorkflowTemplateRepository,
  callbacks: WorkflowWorkspaceCallbacks,
) {
  let sessionId = "";
  let runs: WorkflowRun[] = [];
  let templates: WorkflowTemplate[] = [];
  let selectedId = "";
  let selectedTemplateId = "";
  let activeTab: "runs" | "templates" = "runs";
  const list = h("div", { className: "workflow-workspace__list" });
  const detail = h("div", { className: "workflow-workspace__detail" });
  const runTab = h("button", { className: "workflow-workspace__tab is-active" }, "运行记录 0");
  const templateTab = h("button", { className: "workflow-workspace__tab" }, "Flow Skills 0");
  const tabs = h("div", { className: "workflow-workspace__tabs" }, runTab, templateTab);
  const close = h("button", { className: "workflow-workspace__close", title: "关闭" }, "×");
  const panel = h(
    "aside",
    { className: "workflow-workspace" },
    h(
      "header",
      { className: "workflow-workspace__header" },
      h("strong", {}, "Dynamic Flow"),
      tabs,
      close,
    ),
    h("div", { className: "workflow-workspace__body" }, list, detail),
  );
  close.addEventListener("click", () => panel.classList.remove("is-open"));
  runTab.addEventListener("click", () => setTab("runs"));
  templateTab.addEventListener("click", () => setTab("templates"));

  function setTab(tab: "runs" | "templates") {
    activeTab = tab;
    runTab.classList.toggle("is-active", tab === "runs");
    templateTab.classList.toggle("is-active", tab === "templates");
    runTab.setAttribute("aria-pressed", String(tab === "runs"));
    templateTab.setAttribute("aria-pressed", String(tab === "templates"));
    renderList();
    if (tab === "runs") renderRunDetail(runs.find((run) => run.id === selectedId));
    else renderTemplateDetail(templates.find((template) => template.id === selectedTemplateId));
  }

  function renderRunDetail(run?: WorkflowRun) {
    detail.replaceChildren();
    if (!run) {
      detail.append(h("div", { className: "workflow-workspace__empty" }, "选择一个 Flow 查看任务图"));
      return;
    }
    const nodeList = h("div", { className: "workflow-detail__nodes" });
    for (const node of run.nodes) {
      const result = h("div", { className: "workflow-detail__result markdown" });
      if (node.result) renderMarkdown(result, node.result);
      nodeList.append(
        h(
          "article",
          { className: `workflow-detail__node workflow-detail__node--${node.status}` },
          h(
            "div",
            { className: "workflow-detail__node-head" },
            h("strong", {}, node.title),
            h(
              "span",
              {},
              `${node.agentId} · ${node.status}${
                node.attempts ? ` · 尝试 ${node.attempts}` : ""
              }`,
            ),
          ),
          h("div", { className: "workflow-detail__goal" }, node.goal),
          h(
            "div",
            { className: "workflow-detail__deps" },
            node.dependsOn.length ? `依赖：${node.dependsOn.join(", ")}` : "入口节点",
          ),
          node.error ? h("div", { className: "workflow-detail__error" }, node.error) : "",
          node.result ? h("details", {}, h("summary", {}, "节点输出"), result) : "",
        ),
      );
    }
    const final = h("div", { className: "workflow-detail__final markdown" });
    if (run.finalAnswer) renderMarkdown(final, run.finalAnswer);
    const resume = h(
      "button",
      {
        className: "workflow-detail__resume",
        title: "保留已完成节点，从最近 Checkpoint 继续",
      },
      "从 Checkpoint 恢复",
    );
    resume.addEventListener("click", () => {
      resume.disabled = true;
      callbacks.onResume(run.id);
    });
    const references = run.matchedTemplates?.length
      ? h(
          "section",
          { className: "workflow-detail__references" },
          h("h3", {}, "召回的 Flow Skills"),
          ...run.matchedTemplates.map((match) =>
            h(
              "div",
              { className: "workflow-detail__reference" },
              h("strong", {}, match.name),
              h("span", {}, `匹配度 ${Math.round(match.score * 100)}%`),
              h("p", {}, match.description),
            )
          ),
        )
      : h(
          "div",
          { className: "workflow-detail__learning" },
          "本次未召回历史 Flow，使用动态规划。",
        );
    const learning = run.qualityScore != null
      ? h(
          "div",
          { className: "workflow-detail__learning" },
          h(
            "strong",
            {},
            run.learnedTemplateName
              ? `已沉淀为 Flow Skill：${run.learnedTemplateName}`
              : "本次 Flow 未进入模板库",
          ),
          h("span", {}, `质量 ${Math.round(run.qualityScore * 100)}%`),
          run.qualityReason ? h("p", {}, run.qualityReason) : "",
        )
      : "";
    detail.append(
      h("h2", {}, run.goal),
      h(
        "div",
        { className: "workflow-detail__meta" },
        `${STATUS_LABEL[run.status]} · ${run.nodes.length} 节点 · Checkpoint #${run.checkpointSeq} · 恢复 ${run.resumeCount} 次`,
      ),
      run.status === "interrupted"
        ? h(
            "div",
            { className: "workflow-detail__resume-row" },
          h(
            "span",
            {},
            `中断于 ${new Date(run.interruptedAt ?? run.updatedAt).toLocaleString()}；已完成节点不会重跑，请确认中断节点的外部写操作可安全重试。`,
          ),
            resume,
          )
        : "",
      h("p", { className: "workflow-detail__summary" }, run.summary),
      h("p", { className: "workflow-detail__description" }, run.description ?? ""),
      references,
      learning,
      nodeList,
      run.finalAnswer ? h("section", {}, h("h3", {}, "最终汇总"), final) : "",
    );
  }

  function renderTemplateDetail(template?: WorkflowTemplate) {
    detail.replaceChildren();
    if (!template) {
      detail.append(h("div", { className: "workflow-workspace__empty" }, "暂无已学习的 Flow Skill"));
      return;
    }
    detail.append(
      h("h2", {}, template.name),
      h(
        "div",
        { className: "workflow-detail__meta" },
        `v${template.version} · 质量 ${Math.round(template.qualityScore * 100)}% · 成功 ${template.successCount} 次`,
      ),
      h("p", { className: "workflow-detail__description" }, template.description),
      h(
        "div",
        { className: "workflow-detail__triggers" },
        h("strong", {}, "触发示例"),
        ...template.triggerExamples.map((trigger) => h("span", {}, trigger)),
      ),
      h(
        "div",
        { className: "workflow-detail__nodes" },
        ...template.nodes.map((node) =>
          h(
            "article",
            { className: "workflow-detail__node" },
            h(
              "div",
              { className: "workflow-detail__node-head" },
              h("strong", {}, node.title),
              h("span", {}, node.id),
            ),
            h("div", { className: "workflow-detail__goal" }, node.goalExample),
            h(
              "div",
              { className: "workflow-detail__deps" },
              node.dependsOn.length ? `依赖：${node.dependsOn.join(", ")}` : "入口节点",
            ),
            h(
              "div",
              { className: "workflow-detail__capabilities" },
              `Skills: ${node.requiredSkillIds.join(", ") || "(none)"} · Tools: ${
                node.requiredTools.join(", ") || "(none)"
              }`,
            ),
          )
        ),
      ),
    );
  }

  function renderList() {
    runTab.textContent = `运行记录 ${runs.length}`;
    templateTab.textContent = `Flow Skills ${templates.length}`;
    list.replaceChildren();
    if (activeTab === "templates") {
      for (const template of templates) {
        const button = h(
          "button",
          {
            className: `workflow-run${template.id === selectedTemplateId ? " is-active" : ""}`,
          },
          h(
            "div",
            { className: "workflow-run__head" },
            h("strong", {}, template.name),
            h("span", {}, `${Math.round(template.qualityScore * 100)}%`),
          ),
          h("div", { className: "workflow-run__goal" }, template.description),
        );
        button.addEventListener("click", () => {
          selectedTemplateId = template.id;
          renderList();
          renderTemplateDetail(template);
        });
        list.append(button);
      }
      if (!templates.length) {
        list.append(h("div", { className: "workflow-workspace__empty" }, "暂无 Flow Skills"));
      }
      return;
    }
    for (const run of runs) {
      const button = h(
        "button",
        { className: `workflow-run${run.id === selectedId ? " is-active" : ""}` },
        h(
          "div",
          { className: "workflow-run__head" },
          h("strong", {}, STATUS_LABEL[run.status]),
          h(
            "span",
            {},
            `${run.nodes.filter((node) => node.status === "completed").length}/${run.nodes.length} · #${run.checkpointSeq}`,
          ),
        ),
        h("div", { className: "workflow-run__goal" }, run.goal),
      );
      button.addEventListener("click", () => {
        selectedId = run.id;
        renderList();
        renderRunDetail(run);
      });
      list.append(button);
    }
    if (!runs.length) {
      list.append(h("div", { className: "workflow-workspace__empty" }, "当前会话暂无 Flow"));
    }
  }

  async function refresh(nextSessionId = sessionId) {
    sessionId = nextSessionId;
    [runs, templates] = await Promise.all([
      sessionId ? repository.list(sessionId) : [],
      templateRepository.list(),
    ]);
    if (!runs.some((run) => run.id === selectedId)) selectedId = runs[0]?.id ?? "";
    if (!templates.some((template) => template.id === selectedTemplateId)) {
      selectedTemplateId = templates[0]?.id ?? "";
    }
    renderList();
    if (activeTab === "runs") renderRunDetail(runs.find((run) => run.id === selectedId));
    else renderTemplateDetail(templates.find((template) => template.id === selectedTemplateId));
  }

  return {
    el: panel,
    async open(nextSessionId: string) {
      panel.classList.add("is-open");
      await refresh(nextSessionId);
    },
    close: () => panel.classList.remove("is-open"),
    refresh,
  };
}
