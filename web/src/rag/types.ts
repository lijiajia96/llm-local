export type RagDocument = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
};

export type RagChunk = {
  id: string;
  documentId: string;
  documentName: string;
  index: number;
  heading: string;
  content: string;
  embedding: number[];
  embeddingModel: string;
};

export type RagMatch = {
  chunk: RagChunk;
  score: number;
  semantic: number;
  lexical: number;
};

export type RagStats = {
  documents: number;
  chunks: number;
  evalCases: number;
};

export type RagEvalCase = {
  id: string;
  question: string;
  expectedDocumentId: string;
  expectedDocumentName: string;
  createdAt: string;
};

export type RagEvalCaseResult = {
  testCase: RagEvalCase;
  matches: RagMatch[];
  firstRelevantRank: number | null;
};

export type RagEvaluation = {
  topK: number;
  total: number;
  hits: number;
  recallAtK: number;
  mrr: number;
  results: RagEvalCaseResult[];
};
