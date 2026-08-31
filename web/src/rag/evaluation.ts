import type { RagEvalCase, RagEvaluation, RagMatch } from "./types";

export async function evaluateRag(
  cases: RagEvalCase[],
  topK: number,
  search: (query: string, limit: number) => Promise<RagMatch[]>,
  onProgress?: (done: number, total: number) => void,
): Promise<RagEvaluation> {
  const results = [];
  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i]!;
    const matches = await search(testCase.question, topK);
    const index = matches.findIndex(
      (match) => match.chunk.documentId === testCase.expectedDocumentId,
    );
    results.push({
      testCase,
      matches,
      firstRelevantRank: index < 0 ? null : index + 1,
    });
    onProgress?.(i + 1, cases.length);
  }
  const hits = results.filter((result) => result.firstRelevantRank != null).length;
  const reciprocalRankSum = results.reduce(
    (sum, result) =>
      sum + (result.firstRelevantRank == null ? 0 : 1 / result.firstRelevantRank),
    0,
  );
  return {
    topK,
    total: cases.length,
    hits,
    recallAtK: cases.length ? hits / cases.length : 0,
    mrr: cases.length ? reciprocalRankSum / cases.length : 0,
    results,
  };
}
