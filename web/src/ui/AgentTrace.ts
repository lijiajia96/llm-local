import type { AgentEvent, PreambleEntry } from "../agent/runner";
import { parseTrace } from "../agent/parser";
import { h } from "./dom";

const BADGE_LABEL: Record<StepCardKind, string> = {
  thought: "Thought",
  action: "Action",
  observation: "Observation",
  error: "Error",
};

type StepCardKind = "thought" | "action" | "observation" | "error";

function iconFor(kind: StepCardKind): string {
  switch (kind) {
    case "thought": return "💭";
    case "action": return "⚡";
    case "observation": return "📎";
    case "error": return "⚠";
  }
}

function stepCard(index: number, kind: StepCardKind, title: string, body: string) {
  const card = h(
    "section",
    { className: `step step--${kind}`, dataset: { kind } },
    h(
      "header",
      { className: "step__header" },
      h("span", { className: "step__index" }, String(index)),
      h("span", { className: "step__icon" }, iconFor(kind)),
      h("span", { className: "step__badge" }, BADGE_LABEL[kind]),
      h("span", { className: "step__title" }, title),
      h("span", { className: "step__caret" }, "▾"),
    ),
    h("div", { className: "step__body" }, body),
  );
  const header = card.querySelector(".step__header")!;
  header.addEventListener("click", () => card.classList.toggle("is-collapsed"));
  return card;
}

/** Turn trace + preambles into an ordered list of renderable items. */
type Item =
  | { kind: "thought"; text: string }
  | { kind: "action"; name: string; input: string }
  | { kind: "observation"; text: string }
  | { kind: "final"; text: string };

function buildItems(trace: string, preambles: PreambleEntry[]): Item[] {
  const blocks = parseTrace(trace);
  const pmap = new Map<number, string[]>();
  for (const p of preambles) {
    const arr = pmap.get(p.afterBlockIdx) ?? [];
    arr.push(p.text);
    pmap.set(p.afterBlockIdx, arr);
  }
  const items: Item[] = [];
  const emitPreamble = (idx: number) => {
    for (const t of pmap.get(idx) ?? []) items.push({ kind: "thought", text: t });
  };
  emitPreamble(0);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.kind === "thought") items.push({ kind: "thought", text: b.text });
    else if (b.kind === "action") {
      // pair action with the following action_input
      const nxt = blocks[i + 1];
      const inputText = nxt && nxt.kind === "action_input" ? nxt.text : "";
      items.push({ kind: "action", name: b.text.trim(), input: inputText });
      if (nxt && nxt.kind === "action_input") i++;
    } else if (b.kind === "action_input") {
      // orphan action_input; skip
    } else if (b.kind === "observation") items.push({ kind: "observation", text: b.text });
    else if (b.kind === "final_answer") items.push({ kind: "final", text: b.text });
    emitPreamble(i + 1);
  }
  return items;
}

export type AgentTraceApi = {
  el: HTMLElement;
  render: (trace: string, preambles: PreambleEntry[]) => void;
  handleEvent: (event: AgentEvent, scrollHost?: HTMLElement) => void;
};

export function createAgentTrace(host: HTMLElement): AgentTraceApi {
  const el = h("div", { className: "trace" });
  host.append(el);
  let contextCard: HTMLElement | null = null;

  /** Latest observation card (for attaching mermaid SVGs). */
  let lastObservationCard: HTMLElement | null = null;
  /** Final-answer card is preserved across re-renders. */
  let finalCard: HTMLElement | null = null;

  const render = (trace: string, preambles: PreambleEntry[]) => {
    const items = buildItems(trace, preambles);
    el.textContent = "";
    lastObservationCard = null;
    if (contextCard) el.append(contextCard);
    let idx = 1;
    for (const item of items) {
      if (item.kind === "thought") {
        el.append(stepCard(idx++, "thought", "思考", item.text));
      } else if (item.kind === "action") {
        const body = item.input ? item.input : "(no input)";
        const card = stepCard(idx++, "action", item.name || "(unknown tool)", body);
        el.append(card);
      } else if (item.kind === "observation") {
        const card = stepCard(idx++, "observation", "工具返回", item.text);
        el.append(card);
        lastObservationCard = card;
      } else if (item.kind === "final") {
        // final rendered separately below
      }
    }
    if (finalCard) el.append(finalCard);
  };

  const handleEvent = (event: AgentEvent, scrollHost?: HTMLElement) => {
    if (event.type === "context") {
      const skillNames = event.skills.map((match) => match.skill.name);
      contextCard = h(
        "section",
        { className: "agent-context" },
        h("div", { className: "agent-context__title" }, "本次 Agent Context"),
        h(
          "div",
          { className: "agent-context__row" },
          h("span", { className: "agent-context__label" }, "Skills"),
          ...(skillNames.length ? skillNames : ["Core Agent"]).map((name) =>
            h("span", { className: "manager-chip skill" }, name),
          ),
        ),
        h(
          "div",
          { className: "agent-context__row" },
          h("span", { className: "agent-context__label" }, "Memory"),
          h("span", {}, `${event.memories.length} 条相关记忆`),
        ),
        h(
          "div",
          { className: "agent-context__row" },
          h("span", { className: "agent-context__label" }, "Tools"),
          h("span", { className: "agent-context__tools" }, event.tools.join(", ") || "(none)"),
        ),
      );
      el.prepend(contextCard);
    }
    if (event.type === "stream" || event.type === "step-end" || event.type === "observation") {
      render(event.trace ?? "", event.preambles ?? []);
    }
    if (event.type === "observation" && event.html && lastObservationCard) {
      const body = lastObservationCard.querySelector(".step__body")!;
      const wrap = h("div", { className: "mermaid-wrap" });
      wrap.innerHTML = event.html;
      body.append(wrap);
    }
    if (event.type === "final") {
      finalCard = h(
        "section",
        { className: "final" },
        h("div", { className: "final__label" }, "Final Answer"),
        h("div", { className: "final__body" }, event.answer),
      );
      el.append(finalCard);
    }
    if (event.type === "max-steps") {
      const c = stepCard(999, "error", "已达最大步数", "Agent 未能给出 Final Answer。");
      el.append(c);
    }
    if (event.type === "error") {
      const c = stepCard(999, "error", event.aborted ? "已中断" : "错误", event.message);
      el.append(c);
    }
    if (scrollHost) scrollHost.scrollTop = scrollHost.scrollHeight;
  };

  return { el, render, handleEvent };
}
