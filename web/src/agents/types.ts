export type AgentProfile = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  aliases?: string[];
  rolePrompt: string;
  model?: string;
  skillIds: string[];
  allowedTools: string[];
  maxSteps: number;
  enabled: boolean;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AgentProfileInput = Omit<
  AgentProfile,
  "id" | "builtin" | "createdAt" | "updatedAt"
> & {
  id?: string;
  builtin?: boolean;
};

export type AgentMentionResult =
  | { kind: "none"; text: string }
  | {
      kind: "matched";
      profile: AgentProfile;
      mention: string;
      goal: string;
    }
  | {
      kind: "unknown";
      mention: string;
      goal: string;
    };

export type AgentTaskStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentTaskInput = {
  sessionId: string;
  agentId: string;
  goal: string;
};

export type AgentTaskProgress = {
  sequence: number;
  at: string;
  phase: string;
  message?: string;
  step?: number;
  totalSteps?: number;
};

export type AgentTask = AgentTaskInput & {
  id: string;
  status: AgentTaskStatus;
  events: AgentTaskProgress[];
  result?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
};

export type AgentTaskRunnerContext = {
  signal: AbortSignal;
  report: (progress: Omit<AgentTaskProgress, "sequence" | "at">) => void;
};

export type AgentTaskRunner = (
  task: Readonly<AgentTask>,
  context: AgentTaskRunnerContext,
) => Promise<string | null>;

export type AgentTaskSchedulerEvent =
  | { type: "task-added"; task: AgentTask }
  | { type: "task-updated"; task: AgentTask }
  | { type: "task-removed"; task: AgentTask };

export type AgentTaskSchedulerListener = (event: AgentTaskSchedulerEvent) => void;
