import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function renderMarkdown(host: HTMLElement, source: string): void {
  const html = marked.parse(source, { async: false });
  host.innerHTML = DOMPurify.sanitize(html);
  for (const link of host.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
}
