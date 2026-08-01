export type SkillManifest = {
  id: string;
  name: string;
  description: string;
  version: string;
  triggers: string[];
  prompt: string;
  allowedTools: string[];
  enabled: boolean;
  builtin: boolean;
  always?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SkillInput = Omit<SkillManifest, "id" | "builtin" | "createdAt" | "updatedAt"> & {
  id?: string;
};

export type SkillMatch = {
  skill: SkillManifest;
  score: number;
  matchedTriggers: string[];
};
