import { openDatabase, requestResult, STORES, transactionDone } from "../storage/database";
import type { WorkflowRun } from "./types";

function normalizeRun(run: WorkflowRun): WorkflowRun {
  return {
    ...run,
    description: run.description ?? run.summary,
    triggerExamples: run.triggerExamples ?? [],
    checkpointSeq: run.checkpointSeq ?? 0,
    lastCheckpointAt: run.lastCheckpointAt ?? run.updatedAt,
    resumeCount: run.resumeCount ?? 0,
    nodes: run.nodes.map((node) => ({
      ...node,
      requiredSkillIds: node.requiredSkillIds ?? [],
      requiredTools: node.requiredTools ?? [],
    })),
  };
}

export class WorkflowRepository {
  private writes = Promise.resolve();

  async put(run: WorkflowRun): Promise<void> {
    const snapshot = structuredClone(normalizeRun(run));
    this.writes = this.writes.then(async () => {
      const db = await openDatabase();
      const tx = db.transaction(STORES.workflowRuns, "readwrite");
      tx.objectStore(STORES.workflowRuns).put(snapshot);
      await transactionDone(tx);
    });
    await this.writes;
  }

  async get(id: string): Promise<WorkflowRun | undefined> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.workflowRuns, "readonly");
    const run = await requestResult(
      tx.objectStore(STORES.workflowRuns).get(id),
    ) as WorkflowRun | undefined;
    return run ? normalizeRun(run) : undefined;
  }

  async list(sessionId: string): Promise<WorkflowRun[]> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.workflowRuns, "readonly");
    const runs = await requestResult(
      tx.objectStore(STORES.workflowRuns).index("sessionId").getAll(sessionId),
    ) as WorkflowRun[];
    return runs
      .map(normalizeRun)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async markInterrupted(sessionId: string): Promise<WorkflowRun[]> {
    const active = (await this.list(sessionId)).filter(
      (run) => run.status === "planning" || run.status === "running",
    );
    if (!active.length) {
      return (await this.list(sessionId)).filter((run) => run.status === "interrupted");
    }
    const now = new Date().toISOString();
    for (const run of active) {
      run.status = "interrupted";
      run.interruptedAt = now;
      run.error = "运行环境已中断，可从最近一次节点 Checkpoint 恢复";
      run.updatedAt = now;
      run.lastCheckpointAt = now;
      run.checkpointSeq++;
      for (const node of run.nodes) {
        if (node.status !== "running") continue;
        node.status = "interrupted";
        node.error = "节点执行被页面刷新或运行环境关闭中断";
        node.taskId = undefined;
        node.finishedAt = undefined;
      }
      await this.put(run);
    }
    return (await this.list(sessionId)).filter((run) => run.status === "interrupted");
  }
}
