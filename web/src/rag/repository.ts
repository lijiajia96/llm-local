import { cosineSimilarity, localEmbedding } from "../memory/embedding";
import { openDatabase, requestResult, STORES, transactionDone } from "../storage/database";
import { lexicalOverlapScore, mmrSelect, tokenize } from "../retrieval/scoring";
import { chunkDocument } from "./chunker";
import type { RagChunk, RagDocument, RagEvalCase, RagMatch, RagStats } from "./types";

const EMBEDDING_MODEL = "Xenova/multilingual-e5-small";
const RECALL_K = 24;
const MMR_LAMBDA = 0.75;

function lexicalScore(queryTokens: Set<string>, chunk: RagChunk): number {
  return lexicalOverlapScore(
    queryTokens,
    `${chunk.documentName} ${chunk.heading} ${chunk.content}`,
    0.85,
  );
}

function mmrRerank(candidates: RagMatch[], limit: number): RagMatch[] {
  return mmrSelect(
    candidates,
    limit,
    MMR_LAMBDA,
    (candidate) => candidate.semantic * 0.7 + candidate.lexical * 0.3,
    (candidate, chosen) =>
      cosineSimilarity(candidate.chunk.embedding, chosen.chunk.embedding),
  );
}

export class RagRepository {
  async listDocuments(): Promise<RagDocument[]> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.ragDocuments, "readonly");
    const documents = await requestResult(
      tx.objectStore(STORES.ragDocuments).getAll(),
    ) as RagDocument[];
    return documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async stats(): Promise<RagStats> {
    const db = await openDatabase();
    const tx = db.transaction(
      [STORES.ragDocuments, STORES.ragChunks, STORES.ragEvalCases],
      "readonly",
    );
    const [documents, chunks, evalCases] = await Promise.all([
      requestResult(tx.objectStore(STORES.ragDocuments).count()),
      requestResult(tx.objectStore(STORES.ragChunks).count()),
      requestResult(tx.objectStore(STORES.ragEvalCases).count()),
    ]);
    return { documents, chunks, evalCases };
  }

  async importDocument(
    name: string,
    mimeType: string,
    source: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<RagDocument> {
    const parts = chunkDocument(source);
    if (!parts.length) throw new Error("文档没有可索引的文本");
    const documentId = crypto.randomUUID();
    const chunks: RagChunk[] = [];
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      const passage = [name, part.heading, part.content].filter(Boolean).join("\n");
      const embedding = await localEmbedding.embed(passage, false);
      chunks.push({
        id: `${documentId}:${String(index).padStart(6, "0")}`,
        documentId,
        documentName: name,
        index,
        heading: part.heading,
        content: part.content,
        embedding,
        embeddingModel: EMBEDDING_MODEL,
      });
      onProgress?.(index + 1, parts.length);
    }
    const now = new Date().toISOString();
    const document: RagDocument = {
      id: documentId,
      name: name.trim().slice(0, 200) || "Untitled",
      mimeType: mimeType || "text/plain",
      size: new Blob([source]).size,
      chunkCount: chunks.length,
      createdAt: now,
      updatedAt: now,
    };
    const db = await openDatabase();
    const tx = db.transaction([STORES.ragDocuments, STORES.ragChunks], "readwrite");
    tx.objectStore(STORES.ragDocuments).add(document);
    const chunkStore = tx.objectStore(STORES.ragChunks);
    for (const chunk of chunks) chunkStore.add(chunk);
    await transactionDone(tx);
    return document;
  }

  async removeDocument(id: string): Promise<void> {
    const db = await openDatabase();
    const readTx = db.transaction([STORES.ragChunks, STORES.ragEvalCases], "readonly");
    const [chunkKeys, caseKeys] = await Promise.all([
      requestResult(readTx.objectStore(STORES.ragChunks).index("documentId").getAllKeys(id)),
      requestResult(
        readTx.objectStore(STORES.ragEvalCases).index("expectedDocumentId").getAllKeys(id),
      ),
    ]);
    const writeTx = db.transaction(
      [STORES.ragDocuments, STORES.ragChunks, STORES.ragEvalCases],
      "readwrite",
    );
    writeTx.objectStore(STORES.ragDocuments).delete(id);
    const chunks = writeTx.objectStore(STORES.ragChunks);
    for (const key of chunkKeys) chunks.delete(key);
    const cases = writeTx.objectStore(STORES.ragEvalCases);
    for (const key of caseKeys) cases.delete(key);
    await transactionDone(writeTx);
  }

  async clear(): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction(
      [STORES.ragDocuments, STORES.ragChunks, STORES.ragEvalCases],
      "readwrite",
    );
    tx.objectStore(STORES.ragDocuments).clear();
    tx.objectStore(STORES.ragChunks).clear();
    tx.objectStore(STORES.ragEvalCases).clear();
    await transactionDone(tx);
  }

  async listEvalCases(): Promise<RagEvalCase[]> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.ragEvalCases, "readonly");
    const cases = await requestResult(
      tx.objectStore(STORES.ragEvalCases).getAll(),
    ) as RagEvalCase[];
    return cases.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async addEvalCase(
    question: string,
    expectedDocument: RagDocument,
  ): Promise<RagEvalCase> {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) throw new Error("测试问题不能为空");
    const cases = await this.listEvalCases();
    const duplicate = cases.find(
      (testCase) =>
        testCase.question.toLowerCase() === normalizedQuestion.toLowerCase()
        && testCase.expectedDocumentId === expectedDocument.id,
    );
    if (duplicate) return duplicate;
    const testCase: RagEvalCase = {
      id: crypto.randomUUID(),
      question: normalizedQuestion.slice(0, 1000),
      expectedDocumentId: expectedDocument.id,
      expectedDocumentName: expectedDocument.name,
      createdAt: new Date().toISOString(),
    };
    const db = await openDatabase();
    const tx = db.transaction(STORES.ragEvalCases, "readwrite");
    tx.objectStore(STORES.ragEvalCases).add(testCase);
    await transactionDone(tx);
    return testCase;
  }

  async removeEvalCase(id: string): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.ragEvalCases, "readwrite");
    tx.objectStore(STORES.ragEvalCases).delete(id);
    await transactionDone(tx);
  }

  async search(query: string, limit = 6): Promise<RagMatch[]> {
    if (!query.trim()) return [];
    const db = await openDatabase();
    const tx = db.transaction(STORES.ragChunks, "readonly");
    const chunks = await requestResult(tx.objectStore(STORES.ragChunks).getAll()) as RagChunk[];
    if (!chunks.length) return [];
    const queryTokens = tokenize(query);
    const queryVector = await localEmbedding.embed(query, true);
    const recalled = chunks
      .map((chunk) => {
        const semantic = chunk.embeddingModel === EMBEDDING_MODEL
          ? Math.max(0, cosineSimilarity(queryVector, chunk.embedding))
          : 0;
        const lexical = lexicalScore(queryTokens, chunk);
        return {
          chunk,
          semantic,
          lexical,
          score: semantic * 0.7 + lexical * 0.3,
        };
      })
      .filter((match) => match.lexical > 0 || match.semantic >= 0.45)
      .sort((a, b) => b.score - a.score)
      .slice(0, RECALL_K);
    return mmrRerank(recalled, limit);
  }
}
