import type { MemoryRepository } from "../memory/repository";
import type { EmbeddingStatus } from "../memory/embedding";
import type { MemoryKind, MemoryRecord, MemoryScope } from "../memory/types";
import type { SkillRepository } from "../skills/repository";
import type { SkillManifest } from "../skills/types";
import { h } from "./dom";

type ManagerTab = "memory" | "skills";

export type AgentManagerCallbacks = {
  onChanged: () => void;
};

const KIND_LABEL: Record<MemoryKind, string> = {
  preference: "偏好",
  fact: "事实",
  episode: "经历",
};

function field(label: string, control: HTMLElement): HTMLElement {
  return h("label", { className: "manager-field" }, h("span", {}, label), control);
}

function empty(text: string): HTMLElement {
  return h("div", { className: "manager-empty" }, text);
}

export function createAgentManager(
  memory: MemoryRepository,
  skills: SkillRepository,
  availableTools: string[],
  cb: AgentManagerCallbacks,
) {
  let activeTab: ManagerTab = "memory";
  let memoryQuery = "";
  let embeddingStatus = memory.getEmbeddingStatus();
  const title = h("h2", { className: "manager__title" }, "Agent 管理");
  const body = h("div", { className: "manager__body" });
  const memoryTab = h("button", { className: "manager-tab" }, "Memory");
  const skillsTab = h("button", { className: "manager-tab" }, "Skills");
  const close = h("button", { className: "manager__close", title: "关闭" }, "×");
  const panel = h(
    "aside",
    { className: "manager" },
    h(
      "header",
      { className: "manager__header" },
      title,
      h("div", { className: "manager-tabs" }, memoryTab, skillsTab),
      close,
    ),
    body,
  );
  const overlay = h("div", { className: "manager-overlay", hidden: true }, panel);
  memory.subscribeEmbedding((status) => {
    embeddingStatus = status;
    const target = overlay.querySelector<HTMLElement>('[data-role="embedding-status"]');
    if (target) target.textContent = embeddingStatusText(status);
    const action = overlay.querySelector<HTMLButtonElement>('[data-role="embedding-action"]');
    if (action && status.state === "ready") {
      action.textContent = "重建向量索引";
      action.disabled = false;
    }
  });

  const setOpen = (open: boolean) => {
    overlay.hidden = !open;
    document.body.classList.toggle("manager-open", open);
  };
  close.addEventListener("click", () => setOpen(false));
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.hidden) setOpen(false);
  });
  memoryTab.addEventListener("click", () => { activeTab = "memory"; void render(); });
  skillsTab.addEventListener("click", () => { activeTab = "skills"; void render(); });

  async function renderMemory() {
    const [records, stats] = await Promise.all([memory.list(), memory.stats()]);
    const query = memoryQuery.trim().toLowerCase();
    const filtered = query
      ? records.filter((record) =>
          `${record.title} ${record.content} ${record.tags.join(" ")}`.toLowerCase().includes(query),
        )
      : records;

    const statsEl = h(
      "div",
      { className: "manager-stats" },
      stat("全部", stats.total),
      stat("偏好", stats.preference),
      stat("事实", stats.fact),
      stat("经历", stats.episode),
    );

    const search = h("input", {
      className: "manager-search",
      type: "search",
      placeholder: "搜索 Memory…",
      value: memoryQuery,
    }) as HTMLInputElement;
    search.addEventListener("change", () => {
      memoryQuery = search.value;
      void renderMemory();
    });
    const clear = h("button", { className: "manager-btn danger" }, "清空当前会话");
    clear.addEventListener("click", async () => {
      if (!confirm("确定删除当前会话的所有 Memory？其他会话不受影响。")) return;
      await memory.clear();
      cb.onChanged();
      await renderMemory();
    });
    const embeddingState = h(
      "div",
      { className: "embedding-state", dataset: { role: "embedding-status" } },
      embeddingStatusText(embeddingStatus),
    );
    const indexButton = h(
      "button",
      { className: "manager-btn", dataset: { role: "embedding-action" } },
      embeddingStatus.state === "ready" ? "重建向量索引" : "加载本地语义模型",
    ) as HTMLButtonElement;
    indexButton.addEventListener("click", async () => {
      indexButton.disabled = true;
      if (embeddingStatus.state !== "ready") {
        memory.warmupEmbeddings();
        indexButton.textContent = "加载中…";
        indexButton.disabled = false;
        return;
      }
      try {
        await memory.rebuildEmbeddings((done, total) => {
          indexButton.textContent = `索引中 ${done}/${total}`;
        });
        indexButton.textContent = "索引完成";
      } finally {
        indexButton.disabled = false;
      }
    });

    const form = memoryForm(async (input) => {
      await memory.save(input);
      cb.onChanged();
      await renderMemory();
    });
    const list = h("div", { className: "manager-list" });
    if (!filtered.length) {
      list.append(empty(query ? "没有匹配的 Memory" : "暂无 Memory。Agent 完成任务后会自动写入经历。"));
    } else {
      for (const record of filtered) list.append(memoryCard(record));
    }
    body.replaceChildren(
      statsEl,
      h("div", { className: "manager-toolbar" }, search, clear),
      h("div", { className: "embedding-toolbar" }, embeddingState, indexButton),
      form,
      h(
        "div",
        { className: "manager-section-title" },
        `当前会话 ${memory.getNamespace().split("/")[1]?.slice(0, 8) ?? ""} · ${filtered.length} 条`,
      ),
      list,
    );
  }

  function embeddingStatusText(status: EmbeddingStatus): string {
    if (status.state === "ready") return `语义检索已就绪 · ${status.model}`;
    if (status.state === "loading") return `正在加载本地语义模型 ${status.progress}%${status.detail ? ` · ${status.detail}` : ""}`;
    if (status.state === "error") return `语义模型失败 · ${status.detail ?? "unknown error"}；当前使用关键词检索`;
    return "语义模型未加载 · 当前使用关键词检索";
  }

  function stat(label: string, value: number) {
    return h(
      "div",
      { className: "manager-stat" },
      h("strong", {}, String(value)),
      h("span", {}, label),
    );
  }

  function memoryForm(onSave: (input: {
    kind: MemoryKind;
    title: string;
    content: string;
    tags: string[];
    importance: number;
    source: "user";
    scope: MemoryScope;
  }) => Promise<void>) {
    const details = h("details", { className: "manager-form" });
    const kind = h("select") as HTMLSelectElement;
    for (const value of ["preference", "fact", "episode"] as MemoryKind[]) {
      kind.append(h("option", { value }, KIND_LABEL[value]));
    }
    const scope = h("select") as HTMLSelectElement;
    for (const value of ["user", "project", "agent"] as MemoryScope[]) {
      scope.append(h("option", { value }, value));
    }
    const memoryTitle = h("input", { placeholder: "简短标题" }) as HTMLInputElement;
    const content = h("textarea", { rows: 3, placeholder: "需要长期保留的内容" }) as HTMLTextAreaElement;
    const tags = h("input", { placeholder: "标签，用逗号分隔" }) as HTMLInputElement;
    const importance = h("input", { type: "range", min: "0", max: "1", step: "0.1", value: "0.7" }) as HTMLInputElement;
    const save = h("button", { className: "manager-btn primary", type: "button" }, "保存 Memory");
    save.addEventListener("click", async () => {
      if (!memoryTitle.value.trim() || !content.value.trim()) return;
      save.setAttribute("disabled", "");
      try {
        await onSave({
          kind: kind.value as MemoryKind,
          title: memoryTitle.value,
          content: content.value,
          tags: tags.value.split(","),
          importance: Number(importance.value),
          source: "user",
          scope: scope.value as MemoryScope,
        });
      } finally {
        save.removeAttribute("disabled");
      }
    });
    details.append(
      h("summary", {}, "＋ 手工添加 Memory"),
      h(
        "div",
        { className: "manager-form__grid" },
        field("类型", kind),
        field("作用域", scope),
        field("重要度", importance),
        field("标题", memoryTitle),
        field("标签", tags),
        field("内容", content),
      ),
      save,
    );
    return details;
  }

  function memoryCard(record: MemoryRecord) {
    const remove = h("button", { className: "manager-card__delete", title: "删除" }, "删除");
    remove.addEventListener("click", async () => {
      await memory.remove(record.id);
      cb.onChanged();
      await renderMemory();
    });
    return h(
      "article",
      { className: `manager-card${record.validTo ? " is-expired" : ""}` },
      h(
        "div",
        { className: "manager-card__head" },
        h("span", { className: `memory-kind memory-kind--${record.kind}` }, KIND_LABEL[record.kind]),
        h("strong", {}, record.title),
        h("span", { className: "manager-card__meta" }, `重要度 ${record.importance.toFixed(1)}`),
        h("span", { className: "manager-card__meta" }, `置信度 ${record.confidence.toFixed(1)}`),
        record.validTo ? h("span", { className: "memory-expired" }, "已失效") : "",
        remove,
      ),
      h("div", { className: "manager-card__content" }, record.content),
      h(
        "div",
        { className: "manager-card__foot" },
        ...record.tags.map((tag) => h("span", { className: "manager-chip" }, tag)),
        h("span", { className: "manager-chip" }, record.scope),
        h("time", {}, new Date(record.updatedAt).toLocaleString()),
      ),
    );
  }

  async function renderSkills() {
    const manifests = await skills.list();
    const enabled = manifests.filter((skill) => skill.enabled).length;
    const reset = h("button", { className: "manager-btn" }, "重置内置 Skills");
    reset.addEventListener("click", async () => {
      await skills.resetBuiltins();
      cb.onChanged();
      await renderSkills();
    });
    const list = h("div", { className: "manager-list" });
    for (const skill of manifests) list.append(skillCard(skill));
    body.replaceChildren(
      h(
        "div",
        { className: "manager-toolbar" },
        h("div", { className: "manager-summary" }, `${enabled}/${manifests.length} 个 Skills 已启用`),
        reset,
      ),
      skillForm(async (input) => {
        await skills.save(input);
        cb.onChanged();
        await renderSkills();
      }),
      h("div", { className: "manager-section-title" }, "Skill Registry"),
      list,
    );
  }

  function skillCard(skill: SkillManifest) {
    const toggle = h("input", { type: "checkbox", checked: skill.enabled }) as HTMLInputElement;
    toggle.disabled = !!skill.always;
    toggle.addEventListener("change", async () => {
      await skills.setEnabled(skill.id, toggle.checked);
      cb.onChanged();
      await renderSkills();
    });
    const actions: Node[] = [
      h("label", { className: "mini-switch" }, toggle, h("span", {})),
    ];
    if (!skill.builtin) {
      const remove = h("button", { className: "manager-card__delete" }, "删除");
      remove.addEventListener("click", async () => {
        await skills.remove(skill.id);
        cb.onChanged();
        await renderSkills();
      });
      actions.push(remove);
    }
    return h(
      "article",
      { className: `manager-card skill-card${skill.enabled ? "" : " is-disabled"}` },
      h(
        "div",
        { className: "manager-card__head" },
        h("span", { className: "skill-icon" }, skill.builtin ? "◆" : "◇"),
        h("strong", {}, skill.name),
        h("span", { className: "manager-card__meta" }, `v${skill.version}`),
        ...actions,
      ),
      h("div", { className: "manager-card__content" }, skill.description),
      h("div", { className: "skill-prompt" }, skill.prompt),
      h(
        "div",
        { className: "manager-card__foot" },
        ...skill.triggers.map((trigger) => h("span", { className: "manager-chip" }, trigger)),
      ),
      h(
        "div",
        { className: "skill-tools" },
        "Tools: ",
        skill.allowedTools.join(", ") || "(none)",
      ),
    );
  }

  function skillForm(onSave: (input: {
    name: string;
    description: string;
    version: string;
    triggers: string[];
    prompt: string;
    allowedTools: string[];
    enabled: boolean;
  }) => Promise<void>) {
    const details = h("details", { className: "manager-form" });
    const name = h("input", { placeholder: "例如：Release Analyst" }) as HTMLInputElement;
    const description = h("input", { placeholder: "能力说明" }) as HTMLInputElement;
    const triggers = h("input", { placeholder: "触发词，用逗号分隔" }) as HTMLInputElement;
    const prompt = h("textarea", { rows: 4, placeholder: "激活后注入的执行指令" }) as HTMLTextAreaElement;
    const toolChecks = new Map<string, HTMLInputElement>();
    const toolsEl = h("div", { className: "manager-tool-grid" });
    for (const tool of availableTools) {
      const check = h("input", { type: "checkbox" }) as HTMLInputElement;
      toolChecks.set(tool, check);
      toolsEl.append(h("label", {}, check, h("span", {}, tool)));
    }
    const save = h("button", { className: "manager-btn primary", type: "button" }, "创建 Skill");
    save.addEventListener("click", async () => {
      if (!name.value.trim() || !description.value.trim() || !prompt.value.trim()) return;
      save.setAttribute("disabled", "");
      try {
        await onSave({
          name: name.value,
          description: description.value,
          version: "1.0.0",
          triggers: triggers.value.split(","),
          prompt: prompt.value,
          allowedTools: [...toolChecks].filter(([, check]) => check.checked).map(([tool]) => tool),
          enabled: true,
        });
      } finally {
        save.removeAttribute("disabled");
      }
    });
    details.append(
      h("summary", {}, "＋ 创建自定义 Skill"),
      h(
        "div",
        { className: "manager-form__grid" },
        field("名称", name),
        field("说明", description),
        field("触发词", triggers),
        field("Skill Prompt", prompt),
        field("工具权限", toolsEl),
      ),
      save,
    );
    return details;
  }

  async function render() {
    memoryTab.classList.toggle("is-active", activeTab === "memory");
    skillsTab.classList.toggle("is-active", activeTab === "skills");
    title.textContent = activeTab === "memory" ? "Memory 管理" : "Skills 管理";
    body.replaceChildren(h("div", { className: "manager-loading" }, "加载中…"));
    if (activeTab === "memory") await renderMemory();
    else await renderSkills();
  }

  return {
    el: overlay,
    async open(tab: ManagerTab) {
      activeTab = tab;
      setOpen(true);
      await render();
    },
  };
}
