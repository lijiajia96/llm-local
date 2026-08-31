export type TextChunk = {
  heading: string;
  content: string;
};

const TARGET_CHARS = 1200;
const OVERLAP_CHARS = 180;

function splitLongText(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + TARGET_CHARS);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf("\n", end),
        text.lastIndexOf("。", end),
        text.lastIndexOf(". ", end),
      );
      if (boundary > start + TARGET_CHARS / 2) end = boundary + 1;
    }
    parts.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(start + 1, end - OVERLAP_CHARS);
  }
  return parts.filter(Boolean);
}

export function chunkDocument(source: string): TextChunk[] {
  const text = source.replace(/\r\n?/g, "\n").trim();
  if (!text) return [];
  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const chunks: TextChunk[] = [];
  let heading = "";
  let buffer = "";

  const flush = () => {
    if (!buffer) return;
    for (const content of splitLongText(buffer)) chunks.push({ heading, content });
    buffer = "";
  };

  for (const block of blocks) {
    const headingMatch = block.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      flush();
      heading = headingMatch[1]!.trim();
      continue;
    }
    if (buffer && buffer.length + block.length + 2 > TARGET_CHARS) flush();
    buffer = buffer ? `${buffer}\n\n${block}` : block;
  }
  flush();
  return chunks;
}
