import type { AgentEvent } from "../agent/runner";

export type TrajectoryRunStart = {
  type: "run-start";
  goal: string;
  model: string;
  source: "main" | "sub-agent";
  agentName?: string;
};

export type TrajectoryRunEnd = {
  type: "run-end";
  status: "completed" | "failed" | "cancelled";
};

export type TrajectoryEvent = AgentEvent | TrajectoryRunStart | TrajectoryRunEnd;

export type TrajectoryEntry = {
  id: string;
  runId: string;
  sessionId: string;
  sequence: number;
  at: string;
  event: TrajectoryEvent;
};

export type TrajectoryRun = {
  runId: string;
  sessionId: string;
  goal: string;
  model: string;
  source: "main" | "sub-agent";
  agentName?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  eventCount: number;
  startedAt: string;
  finishedAt?: string;
};
