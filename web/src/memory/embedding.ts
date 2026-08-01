export type EmbeddingState = "idle" | "loading" | "ready" | "error";

export type EmbeddingStatus = {
  state: EmbeddingState;
  progress: number;
  model: string;
  detail?: string;
};

type PendingRequest = {
  resolve: (vector: number[]) => void;
  reject: (error: Error) => void;
};

const MODEL_ID = "Xenova/multilingual-e5-small";

export class LocalEmbeddingService {
  private worker: Worker | null = null;
  private sequence = 0;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Set<(status: EmbeddingStatus) => void>();
  private status: EmbeddingStatus = {
    state: "idle",
    progress: 0,
    model: MODEL_ID,
  };

  getStatus(): EmbeddingStatus {
    return { ...this.status };
  }

  isReady(): boolean {
    return this.status.state === "ready";
  }

  subscribe(listener: (status: EmbeddingStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  warmup(): void {
    if (this.status.state === "loading" || this.status.state === "ready") return;
    this.ensureWorker().postMessage({ type: "load" });
  }

  async embed(text: string, query = false): Promise<number[]> {
    const id = ++this.sequence;
    const worker = this.ensureWorker();
    const result = new Promise<number[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    worker.postMessage({ type: "embed", id, text: text.slice(0, 4000), query });
    return await result;
  }

  async embedIfReady(text: string, query = false): Promise<number[] | null> {
    if (!this.isReady()) {
      this.warmup();
      return null;
    }
    try {
      return await this.embed(text, query);
    } catch {
      return null;
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL("./embedding.worker.ts", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", (event: MessageEvent<{
      type: "status" | "result" | "error";
      id?: number;
      vector?: Float32Array;
      message?: string;
      state?: EmbeddingState;
      progress?: number;
      model?: string;
      detail?: string;
    }>) => {
      const message = event.data;
      if (message.type === "status" && message.state) {
        this.setStatus({
          state: message.state,
          progress: message.progress ?? 0,
          model: message.model ?? MODEL_ID,
          detail: message.detail,
        });
        return;
      }
      if (message.id == null) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.type === "result" && message.vector) {
        pending.resolve(Array.from(message.vector));
      } else {
        pending.reject(new Error(message.message ?? "Embedding worker failed"));
      }
    });
    this.worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "Embedding worker crashed");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.setStatus({ state: "error", progress: 0, model: MODEL_ID, detail: error.message });
    });
    return this.worker;
  }

  private setStatus(status: EmbeddingStatus) {
    this.status = status;
    for (const listener of this.listeners) listener(this.getStatus());
  }
}

export const localEmbedding = new LocalEmbeddingService();

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}
