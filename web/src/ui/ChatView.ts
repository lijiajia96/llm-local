import { h } from "./dom";

export type ChatViewApi = {
  el: HTMLElement;
  chatEl: HTMLElement;
  addMessage: (node: HTMLElement) => void;
  clear: () => void;
  scrollToBottom: () => void;
  setEmptyMode: (agent: boolean) => void;
};

export function createChatView(): ChatViewApi {
  const empty = h(
    "div",
    { className: "empty-state" },
    h(
      "div",
      { className: "empty-state__card" },
      h("div", { className: "empty-state__icon" }, "✨"),
      h("h2", { className: "empty-state__title" }, "开始一次新的对话"),
      h(
        "div",
        { className: "empty-state__hints" },
        h(
          "div",
          { className: "empty-state__hint" },
          h("span", { className: "empty-state__hint-key" }, "💬 普通模式"),
          h("span", {}, "文字 / 图片对话，流式输出"),
        ),
        h(
          "div",
          { className: "empty-state__hint" },
          h("span", { className: "empty-state__hint-key" }, "🤖 Agent 模式"),
          h("span", {}, "ReAct 循环：模型自主调用工具完成任务"),
        ),
        h(
          "div",
          { className: "empty-state__hint" },
          h("span", { className: "empty-state__hint-key" }, "Flow 模式"),
          h("span", {}, "Planner 生成 DAG，多 Agent 并行执行并汇总"),
        ),
      ),
    ),
  );

  const chatEl = h("div", { className: "chat__scroll" }, empty);
  const el = h("main", { className: "chat" }, chatEl);

  return {
    el,
    chatEl,
    addMessage(node) {
      empty.remove();
      chatEl.append(node);
      chatEl.scrollTop = chatEl.scrollHeight;
    },
    clear() {
      chatEl.textContent = "";
      chatEl.append(empty);
    },
    scrollToBottom() {
      chatEl.scrollTop = chatEl.scrollHeight;
    },
    setEmptyMode(agent) {
      empty.dataset.mode = agent ? "agent" : "chat";
    },
  };
}
