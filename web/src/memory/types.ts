export type MemoryKind = "preference" | "fact" | "episode";
export type MemorySource = "user" | "agent" | "system";
export type MemoryScope = "user" | "project" | "agent";

export type MemoryRecord = {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  confidence: number;
  source: MemorySource;
  scope: MemoryScope;
  namespace: string;
  validFrom: string;
  validTo?: string;
  supersedes?: string;
  lastAccessedAt: string;
  accessCount: number;
  embedding?: number[];
  embeddingModel?: string;
  createdAt: string;
  updatedAt: string;
};

export type MemoryInput = {
  kind: MemoryKind;
  title: string;
  content: string;
  tags?: string[];
  importance?: number;
  confidence?: number;
  source?: MemorySource;
  scope?: MemoryScope;
};

export type MemoryMatch = {
  record: MemoryRecord;
  score: number;
};

export type MemoryStats = Record<MemoryKind, number> & { total: number };
