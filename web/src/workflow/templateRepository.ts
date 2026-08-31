import { cosineSimilarity, localEmbedding } from "../memory/embedding";
import { lexicalOverlapScore, mmrSelect, tokenize } from "../retrieval/scoring";
import { openDatabase, requestResult, STORES, transactionDone } from "../storage/database";
import type {
  WorkflowTemplate,
  WorkflowTemplateMatch,
} from "./types";

const EMBEDDING_MODEL = "Xenova/multilingual-e5-small";
const RECALL_K = 20;
const MMR_LAMBDA = 0.7;

function searchableText(template: WorkflowTemplate): string {
  return [
    template.name,
    template.description,
    ...template.triggerExamples,
    template.exampleGoal,
    template.summary,
  ].join("\n");
}

function qualityScore(template: WorkflowTemplate): number {
  const repeatedSuccess = Math.min(1, Math.log2(template.successCount + 1) / 4);
  return template.qualityScore * 0.75 + repeatedSuccess * 0.25;
}

export class WorkflowTemplateRepository {
  async get(id: string): Promise<WorkflowTemplate | undefined> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.workflowTemplates, "readonly");
    return await requestResult(
      tx.objectStore(STORES.workflowTemplates).get(id),
    ) as WorkflowTemplate | undefined;
  }

  async list(): Promise<WorkflowTemplate[]> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.workflowTemplates, "readonly");
    const templates = await requestResult(
      tx.objectStore(STORES.workflowTemplates).getAll(),
    ) as WorkflowTemplate[];
    return templates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async put(template: WorkflowTemplate): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.workflowTemplates, "readwrite");
    tx.objectStore(STORES.workflowTemplates).put(structuredClone(template));
    await transactionDone(tx);
  }

  async findBySourceRun(sourceRunId: string): Promise<WorkflowTemplate | undefined> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.workflowTemplates, "readonly");
    return await requestResult(
      tx.objectStore(STORES.workflowTemplates).index("sourceRunId").get(sourceRunId),
    ) as WorkflowTemplate | undefined;
  }

  async search(query: string, limit = 3): Promise<WorkflowTemplateMatch[]> {
    const templates = (await this.list()).filter((template) => template.enabled);
    if (!templates.length || !query.trim()) return [];

    let queryVector: number[] | null = null;
    try {
      queryVector = await localEmbedding.embed(query, true);
    } catch {
      queryVector = null;
    }
    const queryTokens = tokenize(query);
    const recalled = templates
      .map((template) => {
        const lexical = lexicalOverlapScore(queryTokens, searchableText(template), 0.8);
        const semantic = queryVector && template.embedding?.length === queryVector.length
          ? Math.max(0, cosineSimilarity(queryVector, template.embedding))
          : 0;
        const quality = qualityScore(template);
        const score = queryVector
          ? semantic * 0.6 + lexical * 0.2 + quality * 0.2
          : lexical * 0.7 + quality * 0.3;
        return { template, score, semantic, lexical };
      })
      .filter((match) => match.lexical > 0 || match.semantic >= 0.48)
      .sort((a, b) => b.score - a.score)
      .slice(0, RECALL_K);

    if (!queryVector || recalled.length <= limit) return recalled.slice(0, limit);
    return mmrSelect(
      recalled,
      limit,
      MMR_LAMBDA,
      (candidate) => candidate.score,
      (candidate, selected) =>
        candidate.template.embedding && selected.template.embedding
          ? cosineSimilarity(candidate.template.embedding, selected.template.embedding)
          : 0,
    );
  }

  async embedForStorage(template: WorkflowTemplate): Promise<WorkflowTemplate> {
    try {
      const embedding = await localEmbedding.embed(searchableText(template), false);
      return { ...template, embedding, embeddingModel: EMBEDDING_MODEL };
    } catch {
      return template;
    }
  }
}
