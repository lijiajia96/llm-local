export function tokenize(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*|[\u4e00-\u9fff]+/g) ?? [];
  const result = new Set<string>();
  for (const token of tokens) {
    if (/^[\u4e00-\u9fff]+$/.test(token)) {
      if (token.length === 1) result.add(token);
      for (let i = 0; i < token.length - 1; i++) result.add(token.slice(i, i + 2));
    } else if (token.length > 1) {
      result.add(token);
    }
  }
  return result;
}

export function lexicalOverlapScore(
  queryTokens: Set<string>,
  candidateText: string,
  coverageWeight: number,
): number {
  if (!queryTokens.size) return 0;
  const candidateTokens = tokenize(candidateText);
  let overlap = 0;
  for (const token of queryTokens) if (candidateTokens.has(token)) overlap++;
  if (!overlap) return 0;
  const coverage = overlap / queryTokens.size;
  const precision = overlap / Math.max(candidateTokens.size, 1);
  return coverage * coverageWeight + precision * (1 - coverageWeight);
}

export function mmrSelect<T>(
  candidates: T[],
  limit: number,
  lambda: number,
  relevance: (candidate: T) => number,
  similarity: (candidate: T, selected: T) => number,
): T[] {
  const pool = [...candidates];
  const selected: T[] = [];
  while (selected.length < limit && pool.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i]!;
      let redundancy = 0;
      for (const chosen of selected) {
        redundancy = Math.max(redundancy, similarity(candidate, chosen));
      }
      const score = lambda * relevance(candidate) - (1 - lambda) * redundancy;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    selected.push(pool.splice(bestIndex, 1)[0]!);
  }
  return selected;
}
