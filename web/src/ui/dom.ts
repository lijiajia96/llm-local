/** Minimal `h` — tag + optional attrs + children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, unknown>> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class" || k === "className") el.className = String(v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k in el) {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

/** Attach or replace children. */
export function replaceChildren(parent: Element, ...nodes: Array<Node | string>) {
  parent.replaceChildren(
    ...nodes.map((n) => (typeof n === "string" ? document.createTextNode(n) : n)),
  );
}

/** Load / persist a JSON-safe scalar. */
export function loadPref<T extends string | boolean>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (raw == null) return fallback;
  if (typeof fallback === "boolean") return (raw === "true") as T;
  return raw as T;
}
export function savePref(key: string, value: string | boolean) {
  localStorage.setItem(key, String(value));
}
