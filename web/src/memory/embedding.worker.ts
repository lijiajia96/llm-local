import { env, pipeline } from "@huggingface/transformers";

const MODEL_ID = "Xenova/multilingual-e5-small";

type WorkerRequest =
  | { type: "load" }
  | { type: "embed"; id: number; text: string; query: boolean };

let extractorPromise: ReturnType<typeof loadExtractor> | null = null;

env.useBrowserCache = true;

async function loadExtractor() {
  self.postMessage({ type: "status", state: "loading", progress: 0, model: MODEL_ID });
  const extractor = await pipeline("feature-extraction", MODEL_ID, {
    device: "wasm",
    dtype: "q8",
    progress_callback: (event: { status?: string; progress?: number; file?: string }) => {
      self.postMessage({
        type: "status",
        state: "loading",
        progress: Math.round(event.progress ?? 0),
        detail: event.file ?? event.status ?? "",
        model: MODEL_ID,
      });
    },
  });
  self.postMessage({ type: "status", state: "ready", progress: 100, model: MODEL_ID });
  return extractor;
}

function getExtractor() {
  extractorPromise ??= loadExtractor();
  return extractorPromise;
}

self.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === "load") {
      await getExtractor();
      return;
    }
    const extractor = await getExtractor();
    const prefix = request.query ? "query: " : "passage: ";
    const result = await extractor(prefix + request.text, {
      pooling: "mean",
      normalize: true,
    });
    const vector = Float32Array.from(result.data as Iterable<number>);
    (self as unknown as {
      postMessage(message: unknown, transfer: Transferable[]): void;
    }).postMessage({ type: "result", id: request.id, vector }, [vector.buffer]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: "error", id: request.type === "embed" ? request.id : undefined, message });
    self.postMessage({ type: "status", state: "error", progress: 0, detail: message, model: MODEL_ID });
  }
});
