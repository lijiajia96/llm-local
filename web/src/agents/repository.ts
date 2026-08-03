import { openDatabase, requestResult, STORES, transactionDone } from "../storage/database";
import { BUILTIN_AGENT_PROFILES } from "./builtins";
import type { AgentProfile, AgentProfileInput } from "./types";

function slugify(value: string): string {
  return value
    .toLocaleLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function unique(values: string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function normalize(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    name: slugify(profile.name) || profile.id,
    displayName: profile.displayName.trim().slice(0, 80),
    description: profile.description.trim().slice(0, 300),
    aliases: unique(profile.aliases ?? [], 20),
    rolePrompt: profile.rolePrompt.trim().slice(0, 6000),
    model: profile.model?.trim().slice(0, 200) || undefined,
    skillIds: unique(profile.skillIds, 30),
    allowedTools: unique(profile.allowedTools, 30),
    maxSteps: Math.min(20, Math.max(1, Math.round(profile.maxSteps))),
  };
}

export class AgentProfileRepository {
  async list(): Promise<AgentProfile[]> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.agentProfiles, "readonly");
    const stored = await requestResult(
      tx.objectStore(STORES.agentProfiles).getAll(),
    ) as AgentProfile[];
    const overrides = new Map(stored.map((profile) => [profile.id, profile]));
    const builtins = BUILTIN_AGENT_PROFILES.map(
      (profile) => overrides.get(profile.id) ?? profile,
    );
    const custom = stored.filter(
      (profile) => !BUILTIN_AGENT_PROFILES.some((builtin) => builtin.id === profile.id),
    );
    return [...builtins, ...custom].sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }

  async save(input: AgentProfileInput): Promise<AgentProfile> {
    const now = new Date().toISOString();
    const id = input.id?.trim()
      || `custom-agent-${slugify(input.name || input.displayName) || Date.now()}`;
    const existing = (await this.list()).find((profile) => profile.id === id);
    const profile = normalize({
      ...input,
      id,
      builtin: existing?.builtin ?? input.builtin ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    const db = await openDatabase();
    const tx = db.transaction(STORES.agentProfiles, "readwrite");
    tx.objectStore(STORES.agentProfiles).put(profile);
    await transactionDone(tx);
    return profile;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const profile = (await this.list()).find((entry) => entry.id === id);
    if (!profile) throw new Error(`Agent profile not found: ${id}`);
    await this.save({ ...profile, enabled });
  }

  async remove(id: string): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.agentProfiles, "readwrite");
    tx.objectStore(STORES.agentProfiles).delete(id);
    await transactionDone(tx);
  }

  async resetBuiltins(): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.agentProfiles, "readwrite");
    const store = tx.objectStore(STORES.agentProfiles);
    for (const profile of BUILTIN_AGENT_PROFILES) store.delete(profile.id);
    await transactionDone(tx);
  }
}
