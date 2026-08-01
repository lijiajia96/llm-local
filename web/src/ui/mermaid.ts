let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

async function loadMermaid() {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = import("mermaid").then((m) => {
    m.default.initialize({ startOnLoad: false, theme: "dark" });
    return m.default;
  });
  return mermaidPromise;
}

let counter = 0;

export async function renderMermaidToSvg(code: string): Promise<string> {
  const mermaid = await loadMermaid();
  const id = `mmd-${Date.now().toString(36)}-${counter++}`;
  const { svg } = await mermaid.render(id, code);
  return svg;
}
