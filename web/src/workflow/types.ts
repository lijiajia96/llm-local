export type WorkflowStatus =
  | "planning"
  | "running"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowNodeStatus =
  | "pending"
  | "running"
  | "interrupted"
  | "completed"
  | "failed"
  | "skipped";

export type WorkflowPlanNode = {
  id: string;
  title: string;
  goal: string;
  agentId: string;
  requiredSkillIds: string[];
  requiredTools: string[];
  dependsOn: string[];
};

export type WorkflowPlan = {
  summary: string;
  description: string;
  triggerExamples: string[];
  nodes: WorkflowPlanNode[];
};

export type WorkflowTemplateNode = {
  id: string;
  title: string;
  goalExample: string;
  requiredSkillIds: string[];
  requiredTools: string[];
  dependsOn: string[];
};

export type WorkflowTemplate = {
  id: string;
  sourceRunId: string;
  name: string;
  description: string;
  triggerExamples: string[];
  exampleGoal: string;
  summary: string;
  nodes: WorkflowTemplateNode[];
  embedding?: number[];
  embeddingModel?: string;
  qualityScore: number;
  qualityReason: string;
  successCount: number;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowTemplateMatch = {
  template: WorkflowTemplate;
  score: number;
  semantic: number;
  lexical: number;
};

export type WorkflowLearningEvaluation = {
  success: boolean;
  score: number;
  reason: string;
  name: string;
  description: string;
  triggerExamples: string[];
};

export type WorkflowNode = WorkflowPlanNode & {
  status: WorkflowNodeStatus;
  taskId?: string;
  result?: string;
  error?: string;
  attempts?: number;
  startedAt?: string;
  finishedAt?: string;
};

export type WorkflowRun = {
  id: string;
  sessionId: string;
  goal: string;
  model: string;
  summary: string;
  description: string;
  triggerExamples: string[];
  status: WorkflowStatus;
  nodes: WorkflowNode[];
  matchedTemplates?: Array<{
    id: string;
    name: string;
    description: string;
    score: number;
  }>;
  learnedTemplateId?: string;
  learnedTemplateName?: string;
  qualityScore?: number;
  qualityReason?: string;
  checkpointSeq: number;
  lastCheckpointAt: string;
  resumeCount: number;
  interruptedAt?: string;
  finalAnswer?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
};

export type WorkflowProgress =
  | { type: "planned"; run: WorkflowRun }
  | { type: "node-updated"; run: WorkflowRun; node: WorkflowNode }
  | { type: "completed"; run: WorkflowRun }
  | { type: "failed"; run: WorkflowRun };
