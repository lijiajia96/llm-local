import { openDatabase, requestResult, STORES, transactionDone } from "../storage/database";
import { cosineSimilarity, localEmbedding, type EmbeddingStatus } from "./embedding";
import { lexicalOverlapScore, mmrSelect, tokenize } from "../retrieval/scoring";
import type {
  MemoryInput,
  MemoryKind,
  MemoryMatch,
  MemoryRecord,
  MemoryScope,
  MemoryStats,
} from "./types";

const MAX_CONTENT_CHARS = 6000;
const DAY_MS = 86_400_000;
const EMBEDDING_MODEL = "Xenova/multilingual-e5-small";
const RECALL_K = 20; // 阶段一召回候选池大小
const MMR_LAMBDA = 0.7; // rerank 相关性权重（1 - λ 为多样性权重）

function newId(): string {
  return crypto.randomUUID?.() ?? `mem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
}

function normalizeRecord(record: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "kind" | "title" | "content">): MemoryRecord {
  const now = new Date().toISOString();
  const createdAt = record.createdAt ?? now;
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    content: record.content,
    tags: record.tags ?? [],
    importance: record.importance ?? 0.6,
    confidence: record.confidence ?? 0.8,
    source: record.source ?? "user",
    scope: record.scope ?? "user",
    namespace: record.namespace ?? "local/default",
    validFrom: record.validFrom ?? createdAt,
    validTo: record.validTo,
    supersedes: record.supersedes,
    lastAccessedAt: record.lastAccessedAt ?? record.updatedAt ?? createdAt,
    accessCount: record.accessCount ?? 0,
    embedding: record.embedding,
    embeddingModel: record.embeddingModel,
    createdAt,
    updatedAt: record.updatedAt ?? createdAt,
  };
}

function lexicalScore(queryTokens: Set<string>, record: MemoryRecord): number {
  return lexicalOverlapScore(
    queryTokens,
    `${record.title} ${record.content} ${record.tags.join(" ")}`,
    0.8,
  );
}

function supportScore(record: MemoryRecord): number {
  const ageDays = Math.max(0, (Date.now() - Date.parse(record.updatedAt)) / DAY_MS);
  const recency = 1 / (1 + ageDays / 30);
  const frequency = Math.min(1, Math.log2(record.accessCount + 1) / 5);
  return record.importance * 0.45
    + record.confidence * 0.25
    + recency * 0.2
    + frequency * 0.1;
}

/**
 * MMR 重排：在相关性与多样性之间平衡，避免注入 LLM 的记忆高度同质、
 * 挤占上下文预算。relevance 与冗余项同为余弦量纲，仅用已有向量，无额外模型。
 */
function mmrRerank(
  candidates: Array<{ record: MemoryRecord; score: number; semantic: number }>,
  limit: number,
  lambda = MMR_LAMBDA,
): MemoryMatch[] {
  return mmrSelect(
    candidates,
    limit,
    lambda,
    (candidate) => candidate.semantic,
    (candidate, chosen) =>
      candidate.record.embedding && chosen.record.embedding
        ? cosineSimilarity(candidate.record.embedding, chosen.record.embedding)
        : 0,
  ).map(({ record, score }) => ({ record, score }));
}

export class MemoryRepository {
  constructor(
    private readonly namespaceProvider: () => string = () => "local/default",
  ) {}

  getNamespace(): string {
    return this.namespaceProvider().replace(/\/+$/, "") || "local/default";
  }

  private namespaceFor(scope: MemoryScope = "user"): string {
    return `${this.getNamespace()}/${scope}`;
  }

  private belongsToCurrentNamespace(record: MemoryRecord): boolean {
    const namespace = this.getNamespace();
    return record.namespace === namespace || record.namespace.startsWith(`${namespace}/`);
  }

  getEmbeddingStatus(): EmbeddingStatus {
    return localEmbedding.getStatus();
  }

  subscribeEmbedding(listener: (status: EmbeddingStatus) => void): () => void {
    return localEmbedding.subscribe(listener);
  }

  warmupEmbeddings(): void {
    localEmbedding.warmup();
  }

  async list(): Promise<MemoryRecord[]> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.memories, "readonly");
    const raw = await requestResult(tx.objectStore(STORES.memories).getAll()) as MemoryRecord[];
    let records = raw.map(normalizeRecord);

    // Bind records from pre-session versions to the first session that opens them.
    if (this.getNamespace().startsWith("session/")) {
      const legacy = records.filter((record) => record.namespace.startsWith("local/"));
      if (legacy.length) {
        const migrated = new Map(
          legacy.map((record) => [
            record.id,
            { ...record, namespace: this.namespaceFor(record.scope) },
          ]),
        );
        await Promise.all([...migrated.values()].map((record) => this.putRaw(record)));
        records = records.map((record) => migrated.get(record.id) ?? record);
      }
    }

    return records
      .filter((record) => this.belongsToCurrentNamespace(record))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async save(input: MemoryInput): Promise<MemoryRecord> {
    const now = new Date().toISOString();
    const title = input.title.trim().slice(0, 160) || "Untitled memory";
    const content = input.content.trim().slice(0, MAX_CONTENT_CHARS);
    const namespace = this.namespaceFor(input.scope);
    const records = await this.list();
    const duplicate = records.find((record) =>
      !record.validTo
      && record.kind === input.kind
      && record.namespace === namespace
      && record.content.trim().toLowerCase() === content.toLowerCase(),
    );
    if (duplicate) {
      const reinforced = {
        ...duplicate,
        importance: Math.min(1, Math.max(duplicate.importance, input.importance ?? 0.6) + 0.03),
        confidence: Math.max(duplicate.confidence, input.confidence ?? 0.8),
        updatedAt: now,
      };
      await this.putRaw(reinforced);
      return reinforced;
    }
    const current = input.kind === "episode"
      ? undefined
      : records.find((record) =>
          !record.validTo
          && record.kind === input.kind
          && record.namespace === namespace
          && record.title.trim().toLowerCase() === title.toLowerCase(),
        );
    const candidateVector = input.source === "agent" && input.kind !== "episode" && localEmbedding.isReady()
      ? await localEmbedding.embed(`${title}\n${content}`, false)
      : null;
    if (!current && candidateVector) {
      const similar = records
        .filter((record) =>
          !record.validTo
          && record.kind === input.kind
          && record.scope === (input.scope ?? "user")
          && record.embedding?.length,
        )
        .map((record) => ({
          record,
          similarity: cosineSimilarity(candidateVector, record.embedding!),
        }))
        .sort((a, b) => b.similarity - a.similarity)[0];
      if (similar && similar.similarity >= 0.8) {
        const reinforced = {
          ...similar.record,
          importance: Math.min(1, Math.max(similar.record.importance, input.importance ?? 0.6) + 0.03),
          confidence: Math.max(similar.record.confidence, input.confidence ?? 0.8),
          tags: normalizeTags([...similar.record.tags, ...(input.tags ?? [])]),
          updatedAt: now,
        };
        await this.putRaw(reinforced);
        return reinforced;
      }
    }

    if (current?.content.trim() === content) {
      const reinforced = {
        ...current,
        importance: Math.min(1, Math.max(current.importance, input.importance ?? 0.6) + 0.03),
        confidence: Math.max(current.confidence, input.confidence ?? 0.8),
        updatedAt: now,
      };
      await this.putRaw(reinforced);
      return reinforced;
    }

    const record: MemoryRecord = {
      id: newId(),
      kind: input.kind,
      title,
      content,
      tags: normalizeTags(input.tags),
      importance: Math.min(1, Math.max(0, input.importance ?? 0.6)),
      confidence: Math.min(1, Math.max(0, input.confidence ?? 0.8)),
      source: input.source ?? "user",
      scope: input.scope ?? "user",
      namespace,
      validFrom: now,
      supersedes: current?.id,
      lastAccessedAt: now,
      accessCount: 0,
      embedding: candidateVector ?? undefined,
      embeddingModel: candidateVector ? EMBEDDING_MODEL : undefined,
      createdAt: now,
      updatedAt: now,
    };
    const db = await openDatabase();
    const tx = db.transaction(STORES.memories, "readwrite");
    const store = tx.objectStore(STORES.memories);
    if (current) store.put({ ...current, validTo: now, updatedAt: now });
    store.put(record);
    await transactionDone(tx);
    void this.indexRecord(record);
    return record;
  }

  async update(record: MemoryRecord): Promise<void> {
    const updated = normalizeRecord({
      ...record,
      title: record.title.trim().slice(0, 160),
      content: record.content.trim().slice(0, MAX_CONTENT_CHARS),
      tags: normalizeTags(record.tags),
      importance: Math.min(1, Math.max(0, record.importance)),
      confidence: Math.min(1, Math.max(0, record.confidence)),
      embedding: undefined,
      embeddingModel: undefined,
      updatedAt: new Date().toISOString(),
    });
    await this.putRaw(updated);
    void this.indexRecord(updated);
  }

  async remove(id: string): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.memories, "readwrite");
    tx.objectStore(STORES.memories).delete(id);
    await transactionDone(tx);
  }

  async clear(kind?: MemoryKind): Promise<void> {
    const records = (await this.list()).filter((record) => !kind || record.kind === kind);
    if (!records.length) return;
    const db = await openDatabase();
    const tx = db.transaction(STORES.memories, "readwrite");
    const store = tx.objectStore(STORES.memories);
    for (const record of records) store.delete(record.id);
    await transactionDone(tx);
  }

  async search(query: string, limit = 6): Promise<MemoryMatch[]> {
    const queryTokens = tokenize(query);
    const queryVector = await localEmbedding.embedIfReady(query, true);
    const records = (await this.list()).filter((record) => !record.validTo);
    if (localEmbedding.isReady()) {
      for (const record of records) {
        if (!record.embedding || record.embeddingModel !== EMBEDDING_MODEL) void this.indexRecord(record);
      }
    }
    // 阶段一 · 召回：混合评分粗排，取较大候选池（保留 semantic 供 rerank 用）
    const recalled = records
      .map((record) => {
        const lexical = lexicalScore(queryTokens, record);
        const semantic = queryVector && record.embedding
          ? Math.max(0, cosineSimilarity(queryVector, record.embedding))
          : 0;
        const support = supportScore(record);
        const score = queryVector
          ? semantic * 0.58 + lexical * 0.27 + support * 0.15
          : lexical * 0.78 + support * 0.22;
        return { record, score, lexical, semantic };
      })
      .filter((match) => match.lexical > 0 || match.semantic >= 0.48)
      .sort((a, b) => b.score - a.score)
      .slice(0, RECALL_K);

    // 阶段二 · 精排：有语义向量时用 MMR 去冗余，否则按粗排截断（安全降级）
    const matches = queryVector && recalled.length > limit
      ? mmrRerank(recalled, limit)
      : recalled.slice(0, limit).map(({ record, score }) => ({ record, score }));

    const accessedAt = new Date().toISOString();
    for (const match of matches) {
      void this.putRaw({
        ...match.record,
        accessCount: match.record.accessCount + 1,
        lastAccessedAt: accessedAt,
      });
    }
    return matches;
  }

  async rebuildEmbeddings(onProgress?: (done: number, total: number) => void): Promise<void> {
    const records = await this.list();
    let done = 0;
    for (const record of records) {
      await this.indexRecord(record, true);
      done++;
      onProgress?.(done, records.length);
    }
  }

  async stats(): Promise<MemoryStats> {
    const records = (await this.list()).filter((record) => !record.validTo);
    const stats: MemoryStats = { total: records.length, preference: 0, fact: 0, episode: 0 };
    for (const record of records) stats[record.kind]++;
    return stats;
  }

  private async indexRecord(record: MemoryRecord, force = false): Promise<void> {
    if (!force && record.embedding?.length && record.embeddingModel === EMBEDDING_MODEL) return;
    const vector = force
      ? await localEmbedding.embed(`${record.title}\n${record.content}`, false)
      : await localEmbedding.embedIfReady(`${record.title}\n${record.content}`, false);
    if (!vector) return;
    await this.putRaw({
      ...record,
      embedding: vector,
      embeddingModel: EMBEDDING_MODEL,
      updatedAt: record.updatedAt,
    });
  }

  private async putRaw(record: MemoryRecord): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.memories, "readwrite");
    tx.objectStore(STORES.memories).put(record);
    await transactionDone(tx);
  }
}
