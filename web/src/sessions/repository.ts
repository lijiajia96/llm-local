import { openDatabase, requestResult, STORES, transactionDone } from "../storage/database";
import type { ChatMessage } from "../types";

export type SessionRecord = {
  id: string;
  title: string;
  history: ChatMessage[];
  agentMode: boolean;
  createdAt: string;
  updatedAt: string;
};

function titleFromHistory(history: ChatMessage[]): string {
  const firstUser = history.find((message) => message.role === "user");
  if (!firstUser) return "新会话";
  const text = typeof firstUser.content === "string"
    ? firstUser.content
    : firstUser.content
        .filter((part) => part.type === "text")
        .map((part) => part.type === "text" ? part.text : "")
        .join(" ");
  return text.trim().replace(/\s+/g, " ").slice(0, 36) || "图片会话";
}

export class SessionRepository {
  async list(): Promise<SessionRecord[]> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.sessions, "readonly");
    const records = await requestResult(
      tx.objectStore(STORES.sessions).getAll(),
    ) as SessionRecord[];
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.sessions, "readonly");
    return await requestResult(
      tx.objectStore(STORES.sessions).get(id),
    ) as SessionRecord | undefined;
  }

  async create(id: string, agentMode: boolean): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id,
      title: "新会话",
      history: [],
      agentMode,
      createdAt: now,
      updatedAt: now,
    };
    await this.put(record);
    return record;
  }

  async ensure(id: string, agentMode: boolean): Promise<SessionRecord> {
    return await this.get(id) ?? await this.create(id, agentMode);
  }

  async saveHistory(
    id: string,
    history: ChatMessage[],
    agentMode: boolean,
  ): Promise<SessionRecord> {
    const current = await this.get(id);
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id,
      title: titleFromHistory(history),
      history: structuredClone(history),
      agentMode,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    await this.put(record);
    return record;
  }

  private async put(record: SessionRecord): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.sessions, "readwrite");
    tx.objectStore(STORES.sessions).put(record);
    await transactionDone(tx);
  }
}
