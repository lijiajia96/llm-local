import { h } from "./dom";

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
  const answer = h("div", { className: "answer" });
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
    answer.textContent = a;
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
    h("div", { className: "sub-agent-result__answer" }, result.answer),
  );
  return h("div", { className: "message message--assistant message--sub-agent" }, bubble);
}
