import { openDatabase, requestResult, STORES, transactionDone } from "../storage/database";
import { BUILTIN_SKILLS } from "./builtins";
import type { SkillInput, SkillManifest } from "./types";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalize(input: SkillManifest): SkillManifest {
  return {
    ...input,
    name: input.name.trim().slice(0, 80),
    description: input.description.trim().slice(0, 300),
    version: input.version.trim().slice(0, 32) || "1.0.0",
    triggers: [...new Set(input.triggers.map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 30),
    allowedTools: [...new Set(input.allowedTools.map((x) => x.trim()).filter(Boolean))],
    prompt: input.prompt.trim().slice(0, 6000),
  };
}

export class SkillRepository {
  async list(): Promise<SkillManifest[]> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.skills, "readonly");
    const stored = await requestResult(tx.objectStore(STORES.skills).getAll()) as SkillManifest[];
    const overrides = new Map(stored.map((skill) => [skill.id, skill]));
    const builtins = BUILTIN_SKILLS.map((skill) => overrides.get(skill.id) ?? skill);
    const custom = stored.filter((skill) => !BUILTIN_SKILLS.some((builtin) => builtin.id === skill.id));
    return [...builtins, ...custom].sort((a, b) => {
      if (a.always !== b.always) return a.always ? -1 : 1;
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async save(input: SkillInput): Promise<SkillManifest> {
    const now = new Date().toISOString();
    const id = input.id?.trim() || `custom-${slugify(input.name) || Date.now()}`;
    const existing = (await this.list()).find((skill) => skill.id === id);
    const skill = normalize({
      ...input,
      id,
      builtin: existing?.builtin ?? false,
      always: existing?.always ?? input.always,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    const db = await openDatabase();
    const tx = db.transaction(STORES.skills, "readwrite");
    tx.objectStore(STORES.skills).put(skill);
    await transactionDone(tx);
    return skill;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const skill = (await this.list()).find((entry) => entry.id === id);
    if (!skill) throw new Error(`Skill not found: ${id}`);
    if (skill.always && !enabled) throw new Error("Core Agent cannot be disabled");
    await this.save({ ...skill, enabled });
  }

  async remove(id: string): Promise<void> {
    const builtin = BUILTIN_SKILLS.find((skill) => skill.id === id);
    const db = await openDatabase();
    const tx = db.transaction(STORES.skills, "readwrite");
    tx.objectStore(STORES.skills).delete(id);
    await transactionDone(tx);
    if (builtin) return;
  }

  async resetBuiltins(): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.skills, "readwrite");
    const store = tx.objectStore(STORES.skills);
    for (const skill of BUILTIN_SKILLS) store.delete(skill.id);
    await transactionDone(tx);
  }
}
