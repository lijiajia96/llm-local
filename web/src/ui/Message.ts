import { h } from "./dom";
import { renderMarkdown } from "./markdown";
import type { WorkflowRun } from "../workflow/types";

/** Split raw assistant text into optional <think>…</think> segment + answer. */
function extractThink(raw: string): { think: string; answer: string } {
  const m = raw.match(/^([\s\S]*?)<\/think>([\s\S]*)$/);
  if (m) return { think: m[1]!.replace(/^<think>/, "").trim(), answer: m[2]! };
  if (raw.startsWith("<think>")) return { think: raw.slice(7), answer: "" };
  return { think: "", answer: raw };
}

export function createUserMessage(text: string, images: string[]) {
  const inner: Array<Node | string> = [];
  for (const url of images) inner.push(h("img", { src: url, alt: "" }));
  if (text) inner.push(h("div", { className: "text" }, text));
  return h("div", { className: "message message--user" }, h("div", { className: "bubble" }, ...inner));
}

/** Assistant message with a streaming updater. */
export function createAssistantMessage() {
  const think = h("div", { className: "think", hidden: true });
  const thinkBody = h("div", { className: "think__body" });
  think.append(h("div", { className: "think__label" }, "思考过程"), thinkBody);
  const answer = h("div", { className: "answer markdown" });
  const bubble = h("div", { className: "bubble" }, think, answer);
  const row = h("div", { className: "message message--assistant" }, bubble);

  function update(raw: string, streaming = true) {
    const { think: t, answer: a } = extractThink(raw);
    if (t) {
      think.hidden = false;
      thinkBody.textContent = t;
    } else {
      think.hidden = true;
    }
    if (streaming) answer.textContent = a;
    else renderMarkdown(answer, a);
    answer.classList.toggle("streaming", streaming);
  }

  function done() { answer.classList.remove("streaming"); }

  function error(msg: string) {
    answer.classList.remove("streaming");
    answer.append(h("div", { className: "message-error" }, "⚠ " + msg));
  }

  return { el: row, update, done, error };
}

export function createAgentMessage() {
  const traceHost = h("div", { className: "agent-trace" });
  const bubble = h("div", { className: "bubble bubble--agent" }, traceHost);
  const row = h("div", { className: "message message--agent" }, bubble);
  return { el: row, traceHost };
}

export type SubAgentResult = {
  agentName: string;
  goal: string;
  answer: string;
};

export function formatSubAgentResult(result: SubAgentResult): string {
  const goal = result.goal.trim().replace(/\s+/g, " ");
  return `[子 Agent：${result.agentName}]\n任务：${goal}\n结果：\n${result.answer}`;
}

export function parseSubAgentResult(content: string): SubAgentResult | null {
  const match = content.match(
    /^\[子 Agent：([^\]]+)\]\n任务：([^\n]*)\n结果：\n([\s\S]*)$/u,
  );
  if (!match) return null;
  return {
    agentName: match[1]!,
    goal: match[2]!,
    answer: match[3]!,
  };
}

export function createSubAgentResultMessage(result: SubAgentResult) {
  const answer = h("div", { className: "sub-agent-result__answer markdown" });
  renderMarkdown(answer, result.answer);
  const bubble = h(
    "div",
    { className: "bubble bubble--sub-agent" },
    h(
      "div",
      { className: "sub-agent-result__head" },
      h("span", {}, "子 Agent"),
      h("strong", {}, result.agentName),
    ),
    h("div", { className: "sub-agent-result__goal" }, result.goal),
    answer,
  );
  return h("div", { className: "message message--assistant message--sub-agent" }, bubble);
}

const FLOW_STATUS_LABEL: Record<WorkflowRun["status"], string> = {
  planning: "规划中",
  running: "执行中",
  interrupted: "待恢复",
  completed: "已完成",
  failed: "部分失败",
  cancelled: "已取消",
};

export function createWorkflowMessage() {
  const summary = h("div", { className: "flow-message__summary" }, "正在生成任务图…");
  const reuse = h("div", { className: "flow-message__reuse", hidden: true });
  const nodes = h("div", { className: "flow-message__nodes" });
  const answer = h("div", { className: "flow-message__answer markdown", hidden: true });
  const status = h("span", { className: "flow-message__status" }, "规划中");
  const bubble = h(
    "div",
    { className: "bubble bubble--flow" },
    h(
      "div",
      { className: "flow-message__head" },
      h("strong", {}, "Dynamic Flow"),
      status,
    ),
    summary,
    reuse,
    nodes,
    answer,
  );
  const el = h("div", { className: "message message--assistant message--flow" }, bubble);

  function update(run: WorkflowRun) {
    status.textContent = FLOW_STATUS_LABEL[run.status];
    status.dataset.status = run.status;
    summary.textContent = run.summary;
    reuse.replaceChildren();
    if (run.matchedTemplates?.length) {
      reuse.hidden = false;
      reuse.append(
        h("strong", {}, "参考 Flow"),
        ...run.matchedTemplates.map((match) =>
          h("span", {}, `${match.name} · ${Math.round(match.score * 100)}%`)
        ),
      );
    } else if (run.learnedTemplateName) {
      reuse.hidden = false;
      reuse.append(
        h("strong", {}, "已学习"),
        h("span", {}, run.learnedTemplateName),
      );
    } else {
      reuse.hidden = true;
    }
    nodes.replaceChildren(...run.nodes.map((node) =>
      h(
        "div",
        { className: `flow-node flow-node--${node.status}` },
        h(
          "div",
          { className: "flow-node__head" },
          h("span", { className: "flow-node__state" }),
          h("strong", {}, node.title),
          h("span", {}, node.agentId),
        ),
        node.dependsOn.length
          ? h("div", { className: "flow-node__deps" }, `依赖：${node.dependsOn.join(", ")}`)
          : h("div", { className: "flow-node__deps" }, "入口节点"),
        node.error ? h("div", { className: "flow-node__error" }, node.error) : "",
      ),
    ));
    if (run.finalAnswer) {
      answer.hidden = false;
      renderMarkdown(answer, run.finalAnswer);
    }
  }

  function error(message: string, cancelled = false) {
    status.textContent = cancelled ? "已取消" : "失败";
    status.dataset.status = cancelled ? "cancelled" : "failed";
    answer.hidden = false;
    answer.textContent = message;
  }

  return { el, update, error };
}
