import { evaluateRag } from "../rag/evaluation";
import type { RagRepository } from "../rag/repository";
import type {
  RagDocument,
  RagEvaluation,
  RagMatch,
} from "../rag/types";
import { h } from "./dom";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = /\.(txt|md|markdown|json|csv|log)$/i;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function createRagManager(
  repository: RagRepository,
  onChanged: () => void,
) {
  let debugQuery = "";
  let debugTopK = 6;
  let debugMatches: RagMatch[] | null = null;
  let evaluation: RagEvaluation | null = null;
  let evaluationTopK = 6;
  let operationError = "";
  const body = h("div", { className: "manager__body" });
  const close = h("button", { className: "manager__close", title: "关闭" }, "×");
  const panel = h(
    "aside",
    { className: "manager" },
    h(
      "header",
      { className: "manager__header rag-manager__header" },
      h("h2", { className: "manager__title" }, "RAG 知识库"),
      close,
    ),
    body,
  );
  const overlay = h("div", { className: "manager-overlay", hidden: true }, panel);

  const setOpen = (open: boolean) => {
    overlay.hidden = !open;
    document.body.classList.toggle("manager-open", open);
  };
  close.addEventListener("click", () => setOpen(false));
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) setOpen(false);
  });

  async function importText(
    name: string,
    mimeType: string,
    text: string,
    button: HTMLButtonElement,
  ) {
    button.disabled = true;
    operationError = "";
    try {
      await repository.importDocument(name, mimeType, text, (done, total) => {
        button.textContent = `索引中 ${done}/${total}`;
      });
      debugMatches = null;
      evaluation = null;
      onChanged();
      await render();
    } catch (error) {
      operationError = (error as Error).message;
      button.textContent = "导入失败";
    } finally {
      button.disabled = false;
    }
  }

  function documentCard(document: RagDocument): HTMLElement {
    const remove = h("button", { className: "manager-card__delete" }, "删除");
    remove.addEventListener("click", async () => {
      await repository.removeDocument(document.id);
      debugMatches = null;
      evaluation = null;
      onChanged();
      await render();
    });
    return h(
      "article",
      { className: "manager-card" },
      h(
        "div",
        { className: "manager-card__head" },
        h("span", { className: "rag-document-icon" }, "DOC"),
        h("strong", {}, document.name),
        remove,
      ),
      h(
        "div",
        { className: "manager-card__foot" },
        h("span", { className: "manager-chip" }, `${document.chunkCount} chunks`),
        h("span", { className: "manager-chip" }, formatBytes(document.size)),
        h("time", {}, new Date(document.updatedAt).toLocaleString()),
      ),
    );
  }

  function topKSelect(value: number): HTMLSelectElement {
    const select = h("select", { className: "rag-top-k", title: "Top-K" }) as HTMLSelectElement;
    for (const option of [1, 3, 5, 6, 10]) {
      select.append(h("option", { value: String(option) }, `Top ${option}`));
    }
    select.value = String(value);
    return select;
  }

  function renderMatches(matches: RagMatch[] | null): HTMLElement {
    if (matches == null) {
      return h("div", { className: "rag-debug-empty" }, "输入问题查看实际召回排序。");
    }
    if (!matches.length) {
      return h("div", { className: "rag-debug-empty" }, "没有召回任何 chunk。");
    }
    const rows = matches.map((match, index) =>
      h(
        "tr",
        {},
        h("td", { className: "rag-rank" }, String(index + 1)),
        h(
          "td",
          {},
          h("strong", {}, match.chunk.documentName),
          match.chunk.heading
            ? h("span", { className: "rag-chunk-heading" }, match.chunk.heading)
            : "",
        ),
        h("td", {}, String(match.chunk.index + 1)),
        h("td", {}, match.semantic.toFixed(4)),
        h("td", {}, match.lexical.toFixed(4)),
        h("td", {}, match.score.toFixed(4)),
      )
    );
    return h(
      "div",
      { className: "rag-results" },
      h(
        "table",
        { className: "rag-results__table" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", {}, "最终排名"),
            h("th", {}, "文档 / Chunk"),
            h("th", {}, "#"),
            h("th", {}, "语义分"),
            h("th", {}, "词法分"),
            h("th", {}, "混合分"),
          ),
        ),
        h("tbody", {}, ...rows),
      ),
      ...matches.map((match, index) =>
        h(
          "details",
          { className: "rag-chunk-preview" },
          h(
            "summary",
            {},
            `#${index + 1} ${match.chunk.documentName} · chunk ${match.chunk.index + 1}`,
          ),
          h("pre", {}, match.chunk.content),
        ),
      ),
    );
  }

  async function render() {
    const [documents, stats, testCases] = await Promise.all([
      repository.listDocuments(),
      repository.stats(),
      repository.listEvalCases(),
    ]);
    const fileInput = h("input", {
      type: "file",
      accept: ".txt,.md,.markdown,.json,.csv,.log,text/plain,text/markdown,application/json,text/csv",
      multiple: true,
      hidden: true,
    }) as HTMLInputElement;
    const upload = h("button", { className: "manager-btn primary" }, "导入文档");
    upload.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const files = [...(fileInput.files ?? [])];
      for (const file of files) {
        if (!ACCEPTED_EXTENSIONS.test(file.name)) {
          upload.textContent = `不支持：${file.name}`;
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          upload.textContent = `文件超过 5 MB：${file.name}`;
          continue;
        }
        await importText(file.name, file.type, await file.text(), upload);
      }
    });

    const clear = h("button", { className: "manager-btn danger" }, "清空知识库");
    clear.addEventListener("click", async () => {
      if (!confirm("确定删除 RAG 知识库中的全部文档和索引？")) return;
      await repository.clear();
      debugMatches = null;
      evaluation = null;
      onChanged();
      await render();
    });

    const name = h("input", { placeholder: "文档名称，例如：项目规范.md" }) as HTMLInputElement;
    const content = h("textarea", {
      rows: 8,
      placeholder: "粘贴 Markdown 或纯文本内容",
    }) as HTMLTextAreaElement;
    const addText = h("button", { className: "manager-btn primary" }, "添加并索引");
    addText.addEventListener("click", async () => {
      if (!name.value.trim() || !content.value.trim()) return;
      await importText(name.value.trim(), "text/plain", content.value, addText);
    });
    const form = h(
      "details",
      { className: "manager-form" },
      h("summary", {}, "＋ 粘贴文本"),
      h(
        "div",
        { className: "manager-form__grid" },
        h("label", { className: "manager-field" }, h("span", {}, "名称"), name),
        h("label", { className: "manager-field" }, h("span", {}, "内容"), content),
      ),
      addText,
    );

    const debugInput = h("input", {
      className: "manager-search",
      type: "search",
      placeholder: "输入问题，检查 Top-K 召回结果",
      value: debugQuery,
    }) as HTMLInputElement;
    const debugK = topKSelect(debugTopK);
    const debug = h("button", { className: "manager-btn primary" }, "执行召回");
    debug.addEventListener("click", async () => {
      debugQuery = debugInput.value.trim();
      debugTopK = Number(debugK.value);
      if (!debugQuery) return;
      debug.disabled = true;
      debug.textContent = "召回中…";
      operationError = "";
      try {
        debugMatches = await repository.search(debugQuery, debugTopK);
      } catch (error) {
        debugMatches = null;
        operationError = (error as Error).message;
      } finally {
        await render();
      }
    });

    const testQuestion = h("input", {
      placeholder: "测试问题",
    }) as HTMLInputElement;
    const expectedDocument = h("select") as HTMLSelectElement;
    if (!documents.length) {
      expectedDocument.append(h("option", { value: "" }, "请先导入文档"));
    } else {
      for (const document of documents) {
        expectedDocument.append(h("option", { value: document.id }, document.name));
      }
    }
    const addCase = h(
      "button",
      { className: "manager-btn", disabled: !documents.length },
      "添加问题",
    );
    addCase.addEventListener("click", async () => {
      const document = documents.find((entry) => entry.id === expectedDocument.value);
      if (!document || !testQuestion.value.trim()) return;
      await repository.addEvalCase(testQuestion.value, document);
      evaluation = null;
      await render();
    });

    const evalK = topKSelect(evaluationTopK);
    const runEvaluation = h(
      "button",
      { className: "manager-btn primary", disabled: !testCases.length },
      "运行评估",
    );
    runEvaluation.addEventListener("click", async () => {
      evaluationTopK = Number(evalK.value);
      runEvaluation.disabled = true;
      operationError = "";
      try {
        evaluation = await evaluateRag(
          testCases,
          evaluationTopK,
          (query, limit) => repository.search(query, limit),
          (done, total) => {
            runEvaluation.textContent = `评估中 ${done}/${total}`;
          },
        );
      } catch (error) {
        evaluation = null;
        operationError = (error as Error).message;
      } finally {
        await render();
      }
    });
    const resultByCase = new Map(
      evaluation?.results.map((result) => [result.testCase.id, result]) ?? [],
    );
    const caseList = h("div", { className: "manager-list rag-eval-list" });
    if (!testCases.length) {
      caseList.append(h(
        "div",
        { className: "manager-empty" },
        "添加问题并指定期望命中的文档，形成可重复执行的评测集。",
      ));
    } else {
      for (const testCase of testCases) {
        const result = resultByCase.get(testCase.id);
        const remove = h("button", { className: "manager-card__delete" }, "删除");
        remove.addEventListener("click", async () => {
          await repository.removeEvalCase(testCase.id);
          evaluation = null;
          onChanged();
          await render();
        });
        caseList.append(h(
          "article",
          { className: "manager-card rag-eval-case" },
          h(
            "div",
            { className: "manager-card__head" },
            h(
              "span",
              {
                className: `rag-eval-status${result ? (result.firstRelevantRank ? " is-hit" : " is-miss") : ""}`,
              },
              result ? (result.firstRelevantRank ? `#${result.firstRelevantRank}` : "MISS") : "NEW",
            ),
            h("strong", {}, testCase.question),
            remove,
          ),
          h(
            "div",
            { className: "manager-card__foot" },
            h("span", { className: "manager-chip" }, `期望：${testCase.expectedDocumentName}`),
          ),
        ));
      }
    }

    const list = h("div", { className: "manager-list" });
    if (documents.length) {
      for (const document of documents) list.append(documentCard(document));
    } else {
      list.append(h(
        "div",
        { className: "manager-empty" },
        "暂无文档。导入后会自动分块并建立本地向量索引。",
      ));
    }
    body.replaceChildren(
      operationError
        ? h("div", { className: "rag-operation-error" }, operationError)
        : "",
      h(
        "div",
        { className: "manager-stats rag-manager__stats" },
        h("div", { className: "manager-stat" }, h("strong", {}, String(stats.documents)), h("span", {}, "文档")),
        h("div", { className: "manager-stat" }, h("strong", {}, String(stats.chunks)), h("span", {}, "Chunks")),
        h("div", { className: "manager-stat" }, h("strong", {}, String(stats.evalCases)), h("span", {}, "测试问题")),
      ),
      h(
        "div",
        { className: "manager-toolbar" },
        h("div", { className: "manager-summary" }, "支持 TXT、Markdown、JSON、CSV、LOG，单文件不超过 5 MB"),
        upload,
        fileInput,
        clear,
      ),
      form,
      h("div", { className: "manager-section-title" }, "全局知识库"),
      list,
      h("div", { className: "manager-section-title" }, "召回调试器"),
      h("div", { className: "manager-toolbar" }, debugInput, debugK, debug),
      renderMatches(debugMatches),
      h("div", { className: "manager-section-title" }, "测试问题集"),
      h(
        "div",
        { className: "rag-eval-form" },
        testQuestion,
        expectedDocument,
        addCase,
      ),
      h(
        "div",
        { className: "manager-toolbar rag-eval-toolbar" },
        evaluation
          ? h(
              "div",
              { className: "rag-eval-metrics" },
              h("span", {}, `Recall@${evaluation.topK} ${(evaluation.recallAtK * 100).toFixed(1)}%`),
              h("span", {}, `MRR ${evaluation.mrr.toFixed(4)}`),
              h("span", {}, `${evaluation.hits}/${evaluation.total} 命中`),
            )
          : h("div", { className: "manager-summary" }, "尚未运行评估"),
        evalK,
        runEvaluation,
      ),
      caseList,
    );
  }

  return {
    el: overlay,
    async open() {
      setOpen(true);
      await render();
    },
  };
}
