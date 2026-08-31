const DB_NAME = "vllm-agent";
const DB_VERSION = 7;

export const STORES = {
  memories: "memories",
  skills: "skills",
  sessions: "sessions",
  agentProfiles: "agentProfiles",
  trajectoryEvents: "trajectoryEvents",
  ragDocuments: "ragDocuments",
  ragChunks: "ragChunks",
  ragEvalCases: "ragEvalCases",
} as const;

let databasePromise: Promise<IDBDatabase> | null = null;

export function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      let memoryStore: IDBObjectStore;
      if (!db.objectStoreNames.contains(STORES.memories)) {
        memoryStore = db.createObjectStore(STORES.memories, { keyPath: "id" });
        memoryStore.createIndex("kind", "kind");
        memoryStore.createIndex("updatedAt", "updatedAt");
      } else {
        memoryStore = request.transaction!.objectStore(STORES.memories);
      }
      if (!memoryStore.indexNames.contains("namespace")) {
        memoryStore.createIndex("namespace", "namespace");
      }
      if (!memoryStore.indexNames.contains("validTo")) {
        memoryStore.createIndex("validTo", "validTo");
      }
      if (!db.objectStoreNames.contains(STORES.skills)) {
        const store = db.createObjectStore(STORES.skills, { keyPath: "id" });
        store.createIndex("enabled", "enabled");
        store.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains(STORES.sessions)) {
        const store = db.createObjectStore(STORES.sessions, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains(STORES.agentProfiles)) {
        const store = db.createObjectStore(STORES.agentProfiles, { keyPath: "id" });
        store.createIndex("enabled", "enabled");
        store.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains(STORES.trajectoryEvents)) {
        const store = db.createObjectStore(STORES.trajectoryEvents, { keyPath: "id" });
        store.createIndex("sessionId", "sessionId");
        store.createIndex("runId", "runId");
        store.createIndex("at", "at");
      }
      if (!db.objectStoreNames.contains(STORES.ragDocuments)) {
        const store = db.createObjectStore(STORES.ragDocuments, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains(STORES.ragChunks)) {
        const store = db.createObjectStore(STORES.ragChunks, { keyPath: "id" });
        store.createIndex("documentId", "documentId");
      }
      if (!db.objectStoreNames.contains(STORES.ragEvalCases)) {
        const store = db.createObjectStore(STORES.ragEvalCases, { keyPath: "id" });
        store.createIndex("expectedDocumentId", "expectedDocumentId");
        store.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another tab"));
  });
  return databasePromise;
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}
