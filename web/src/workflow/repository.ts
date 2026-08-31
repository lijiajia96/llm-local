import { openDatabase, requestResult, STORES, transactionDone } from "../storage/database";
import type { WorkflowRun } from "./types";

export class WorkflowRepository {
  private writes = Promise.resolve();

  async put(run: WorkflowRun): Promise<void> {
    const snapshot = structuredClone(run);
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
    return await requestResult(
      tx.objectStore(STORES.workflowRuns).get(id),
    ) as WorkflowRun | undefined;
  }

  async list(sessionId: string): Promise<WorkflowRun[]> {
    const db = await openDatabase();
    const tx = db.transaction(STORES.workflowRuns, "readonly");
    const runs = await requestResult(
      tx.objectStore(STORES.workflowRuns).index("sessionId").getAll(sessionId),
    ) as WorkflowRun[];
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
