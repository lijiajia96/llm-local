import { h } from "./dom";

export type ComposerModel = {
  attachments: string[]; // data URLs
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

  const autoGrow = () => {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 220) + "px";
  };
  textarea.addEventListener("input", autoGrow);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      trigger();
    }
  });

  let currentAttachments: string[] = [];
  let running = false;

  const trigger = () => {
    if (running) {
      cb.onStop();
      return;
    }
    const text = textarea.value.trim();
    if (!text && !currentAttachments.length) return;
    cb.onSubmit(text, currentAttachments.slice());
    textarea.value = "";
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

  const hint = h("div", { className: "composer__hint" }, "Enter 发送 · Shift+Enter 换行");

  const el = h(
    "footer",
    { className: "composer" },
    attachmentsEl,
    h(
      "div",
      { className: "composer__row" },
      imgBtn,
      fileInput,
      textarea,
      submitBtn,
    ),
    hint,
  );

  function update(m: ComposerModel) {
    currentAttachments = m.attachments;
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
