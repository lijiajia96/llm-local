import { suggestAgentProfiles } from "../agents/mention-parser";
import type { AgentProfile } from "../agents/types";
import { h } from "./dom";

export type ComposerModel = {
  attachments: string[]; // data URLs
  agentProfiles: AgentProfile[];
  agentMode: boolean;
  running: boolean;
};

export type ComposerCallbacks = {
  onSubmit: (text: string, attachments: string[]) => void;
  onStop: () => void;
  onFilesPicked: (files: File[]) => void;
  onRemoveAttachment: (index: number) => void;
};

export function createComposer(cb: ComposerCallbacks) {
  const attachmentsEl = h("div", { className: "composer__attachments" });
  const mentionMenu = h("div", {
    className: "composer__mention-menu",
    role: "listbox",
    hidden: true,
  });

  const fileInput = h("input", {
    type: "file",
    accept: "image/*",
    multiple: true,
    hidden: true,
  }) as HTMLInputElement;
  fileInput.addEventListener("change", () => {
    const files = fileInput.files ? Array.from(fileInput.files) : [];
    fileInput.value = "";
    cb.onFilesPicked(files);
  });

  const imgBtn = h(
    "button",
    { className: "composer__icon-btn", title: "上传图片（仅普通模式支持）", onClick: () => fileInput.click() },
    "🖼",
  ) as HTMLButtonElement;

  const textarea = h("textarea", {
    className: "composer__input",
    rows: 1,
    placeholder: "输入消息…（Enter 发送，Shift+Enter 换行）",
  }) as HTMLTextAreaElement;

  const submitBtn = h(
    "button",
    { className: "composer__submit" },
    h("span", { className: "composer__submit-label" }, "发送"),
  ) as HTMLButtonElement;

  let currentAttachments: string[] = [];
  let currentProfiles: AgentProfile[] = [];
  let suggestions: AgentProfile[] = [];
  let activeSuggestion = 0;
  let running = false;

  const autoGrow = () => {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 220) + "px";
  };

  const hideMentionMenu = () => {
    mentionMenu.hidden = true;
    mentionMenu.replaceChildren();
    suggestions = [];
    activeSuggestion = 0;
  };

  const chooseProfile = (profile: AgentProfile) => {
    textarea.value = `@${profile.name} `;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    hideMentionMenu();
    autoGrow();
    textarea.focus();
  };

  const setActiveSuggestion = (index: number) => {
    activeSuggestion = index;
    Array.from(mentionMenu.children).forEach((child, childIndex) => {
      child.classList.toggle("is-active", childIndex === index);
      child.setAttribute("aria-selected", childIndex === index ? "true" : "false");
    });
  };

  const renderMentionMenu = () => {
    const token = textarea.value.trimStart();
    if (running || !/^[@＠][^\s:：]*$/u.test(token)) {
      hideMentionMenu();
      return;
    }
    suggestions = suggestAgentProfiles(token, currentProfiles, 8);
    if (!suggestions.length) {
      hideMentionMenu();
      return;
    }
    activeSuggestion = Math.min(activeSuggestion, suggestions.length - 1);
    mentionMenu.replaceChildren(
      ...suggestions.map((profile, index) => {
        const option = h(
          "button",
          {
            className: `mention-option${index === activeSuggestion ? " is-active" : ""}`,
            type: "button",
            role: "option",
            ariaSelected: index === activeSuggestion ? "true" : "false",
          },
          h(
            "span",
            { className: "mention-option__identity" },
            h("strong", {}, profile.displayName),
            h("span", {}, `@${profile.name}`),
          ),
          h("span", { className: "mention-option__description" }, profile.description),
        );
        option.addEventListener("mousedown", (event) => event.preventDefault());
        option.addEventListener("click", () => chooseProfile(profile));
        option.addEventListener("mouseenter", () => setActiveSuggestion(index));
        return option;
      }),
    );
    mentionMenu.hidden = false;
  };

  textarea.addEventListener("input", () => {
    autoGrow();
    activeSuggestion = 0;
    renderMentionMenu();
  });
  textarea.addEventListener("focus", renderMentionMenu);
  textarea.addEventListener("blur", () => {
    window.setTimeout(hideMentionMenu, 120);
  });
  textarea.addEventListener("keydown", (e) => {
    if (!mentionMenu.hidden && suggestions.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const direction = e.key === "ArrowDown" ? 1 : -1;
        activeSuggestion = (
          activeSuggestion + direction + suggestions.length
        ) % suggestions.length;
        setActiveSuggestion(activeSuggestion);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        chooseProfile(suggestions[activeSuggestion]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideMentionMenu();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      trigger();
    }
  });

  const trigger = () => {
    if (running) {
      cb.onStop();
      return;
    }
    const text = textarea.value.trim();
    if (!text && !currentAttachments.length) return;
    cb.onSubmit(text, currentAttachments.slice());
    textarea.value = "";
    hideMentionMenu();
    autoGrow();
  };
  submitBtn.addEventListener("click", trigger);

  textarea.addEventListener("paste", (e) => {
    if (imgBtn.disabled) return;
    const items = e.clipboardData?.items ?? [];
    const imgs: File[] = [];
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (imgs.length) {
      e.preventDefault();
      cb.onFilesPicked(imgs);
    }
  });

  const hint = h(
    "div",
    { className: "composer__hint" },
    "输入 @ 选择 Agent · Enter 发送 · Shift+Enter 换行",
  );

  const el = h(
    "footer",
    { className: "composer" },
    attachmentsEl,
    h(
      "div",
      { className: "composer__shell" },
      mentionMenu,
      h(
        "div",
        { className: "composer__row" },
        imgBtn,
        fileInput,
        textarea,
        submitBtn,
      ),
    ),
    hint,
  );

  function update(m: ComposerModel) {
    currentAttachments = m.attachments;
    currentProfiles = m.agentProfiles.filter((profile) => profile.enabled);
    // attachments
    attachmentsEl.textContent = "";
    for (let i = 0; i < m.attachments.length; i++) {
      const url = m.attachments[i]!;
      const rm = h(
        "button",
        { className: "attachment__remove", title: "移除", onClick: () => cb.onRemoveAttachment(i) },
        "×",
      );
      attachmentsEl.append(
        h("div", { className: "attachment" }, h("img", { src: url, alt: "" }), rm),
      );
    }
    attachmentsEl.hidden = m.attachments.length === 0;

    running = m.running;
    if (running) hideMentionMenu();
    submitBtn.classList.toggle("is-stop", m.running);
    submitBtn.querySelector(".composer__submit-label")!.textContent = m.running ? "停止" : "发送";

    imgBtn.disabled = m.agentMode;
    textarea.placeholder = m.agentMode
      ? "输入任务，Agent 会自主调用工具完成…（如：搜索一下 vLLM 最新版本）"
      : "输入消息…（Enter 发送，Shift+Enter 换行）";
  }

  return { el, update, focus: () => textarea.focus() };
}

export type ComposerApi = ReturnType<typeof createComposer>;
