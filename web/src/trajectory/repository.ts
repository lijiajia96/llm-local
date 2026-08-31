import type { AgentEvent } from "../agent/runner";
import { openDatabase, requestResult, STORES, transactionDone } from "../storage/database";
import type {
  TrajectoryEntry,
  TrajectoryEvent,
  TrajectoryRun,
  TrajectoryRunEnd,
  TrajectoryRunStart,
} from "./types";

function entryId(runId: string, sequence: number): string {
  return `${runId}:${String(sequence).padStart(8, "0")}`;
}

function persistedEvent(event: AgentEvent): AgentEvent {
  if (event.type === "context") {
    return {
      ...event,
      memories: event.memories.map((match) => ({
        ...match,
        record: { ...match.record, embedding: undefined },
      })),
      ragMatches: event.ragMatches.map((match) => ({
        ...match,
        chunk: { ...match.chunk, embedding: [] },
      })),
    };
  }
  if (event.type === "observation") return { ...event, html: undefined };
  return structuredClone(event);
}

export class TrajectoryWriter {
  private sequence = 0;
  private queue = Promise.resolve();

  constructor(
    private readonly repository: TrajectoryRepository,
    readonly runId: string,
    readonly sessionId: string,
  ) {}

  start(event: TrajectoryRunStart): void {
    this.enqueue(event);
  }

  append(event: AgentEvent): void {
    if (event.type === "stream") return;
    this.enqueue(persistedEvent(event));
  }

  finish(status: TrajectoryRunEnd["status"]): void {
    this.enqueue({ type: "run-end", status });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private enqueue(event: TrajectoryEvent): void {
    const sequence = this.sequence++;
    this.queue = this.queue
      .then(() => this.repository.append({
        id: entryId(this.runId, sequence),
        runId: this.runId,
        sessionId: this.sessionId,
        sequence,
        at: new Date().toISOString(),
        event,
      }))
      .catch((error) => {
        console.warn("Trajectory event save failed", error);
      });
  }
}

export class TrajectoryRepository {
  async startRun(
    sessionId: string,
    start: Omit<TrajectoryRunStart, "type">,
    runId: string = crypto.randomUUID(),
  ): Promise<TrajectoryWriter> {
    const writer = new TrajectoryWriter(this, runId, sessionId);
    writer.start({ type: "run-start", ...start });
    await writer.flush();
    return writer;
  }

  async listRuns(sessionId: string): Promise<TrajectoryRun[]> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.trajectoryEvents, "readonly");
    const entries = await requestResult(
      tx.objectStore(STORES.trajectoryEvents).index("sessionId").getAll(sessionId),
    ) as TrajectoryEntry[];
    const grouped = new Map<string, TrajectoryEntry[]>();
    for (const entry of entries) {
      const group = grouped.get(entry.runId) ?? [];
      group.push(entry);
      grouped.set(entry.runId, group);
    }
    const runs: TrajectoryRun[] = [];
    for (const [runId, group] of grouped) {
      group.sort((a, b) => a.sequence - b.sequence);
      const first = group.find((entry) => entry.event.type === "run-start");
      if (!first || first.event.type !== "run-start") continue;
      const last = [...group].reverse().find((entry) => entry.event.type === "run-end");
      const end = last?.event.type === "run-end" ? last.event : undefined;
      runs.push({
        runId,
        sessionId,
        goal: first.event.goal,
        model: first.event.model,
        source: first.event.source,
        agentName: first.event.agentName,
        status: end?.status ?? "running",
        eventCount: group.length,
        startedAt: first.at,
        finishedAt: last?.at,
      });
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async getEntries(runId: string): Promise<TrajectoryEntry[]> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.trajectoryEvents, "readonly");
    const entries = await requestResult(
      tx.objectStore(STORES.trajectoryEvents).index("runId").getAll(runId),
    ) as TrajectoryEntry[];
    return entries.sort((a, b) => a.sequence - b.sequence);
  }

  async append(entry: TrajectoryEntry): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.trajectoryEvents, "readwrite");
    tx.objectStore(STORES.trajectoryEvents).add(entry);
    await transactionDone(tx);
  }
}
