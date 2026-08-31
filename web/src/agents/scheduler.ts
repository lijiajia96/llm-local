import type {
  AgentTask,
  AgentTaskInput,
  AgentTaskProgress,
  AgentTaskRunner,
  AgentTaskSchedulerEvent,
  AgentTaskSchedulerListener,
  AgentTaskStatus,
} from "./types";

export type AgentTaskSchedulerOptions = {
  runner: AgentTaskRunner;
  maxConcurrency?: number;
  maxEventsPerTask?: number;
  idFactory?: () => string;
  now?: () => Date;
};

const TERMINAL_STATUSES: ReadonlySet<AgentTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
] as const);

function defaultIdFactory(): string {
  return crypto.randomUUID?.()
    ?? `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function validateConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("maxConcurrency must be a positive integer");
  }
  return value;
}

function validateEventLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("maxEventsPerTask must be a positive integer");
  }
  return value;
}

function cloneTask(task: AgentTask): AgentTask {
  return structuredClone(task);
}

export class AgentTaskScheduler {
  private readonly runner: AgentTaskRunner;
  private readonly maxEventsPerTask: number;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly tasks = new Map<string, AgentTask>();
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Set<AgentTaskSchedulerListener>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly taskWaiters = new Map<string, Set<(task: AgentTask) => void>>();
  private maxConcurrency: number;

  constructor(options: AgentTaskSchedulerOptions) {
    this.runner = options.runner;
    this.maxConcurrency = validateConcurrency(options.maxConcurrency ?? 3);
    this.maxEventsPerTask = validateEventLimit(options.maxEventsPerTask ?? 200);
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.now = options.now ?? (() => new Date());
  }

  get activeCount(): number {
    return this.controllers.size;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  submit(input: AgentTaskInput): AgentTask {
    const sessionId = input.sessionId.trim();
    const agentId = input.agentId.trim();
    const goal = input.goal.trim();
    if (!sessionId || !agentId || !goal) {
      throw new Error("sessionId, agentId, and goal are required");
    }

    const id = this.idFactory();
    if (this.tasks.has(id)) throw new Error(`duplicate task id: ${id}`);
    const now = this.timestamp();
    const task: AgentTask = {
      id,
      sessionId,
      agentId,
      goal,
      workflowId: input.workflowId,
      workflowNodeId: input.workflowNodeId,
      dependsOn: input.dependsOn ? [...input.dependsOn] : undefined,
      status: "queued",
      events: [],
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(id, task);
    this.queue.push(id);
    this.emit("task-added", task);
    this.drain();
    return cloneTask(task);
  }

  getTask(id: string): AgentTask | undefined {
    const task = this.tasks.get(id);
    return task ? cloneTask(task) : undefined;
  }

  listTasks(): AgentTask[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(cloneTask);
  }

  subscribe(listener: AgentTaskSchedulerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setMaxConcurrency(value: number): void {
    this.maxConcurrency = validateConcurrency(value);
    this.drain();
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || TERMINAL_STATUSES.has(task.status)) return false;

    const queuedIndex = this.queue.indexOf(id);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.finish(task, "cancelled");
      this.resolveIdleIfNeeded();
      return true;
    }

    const controller = this.controllers.get(id);
    if (!controller) return false;
    task.status = "cancelling";
    task.updatedAt = this.timestamp();
    this.appendProgress(task, {
      phase: "cancelling",
      message: "已请求停止任务",
    });
    this.emit("task-updated", task);
    controller.abort();
    return true;
  }

  remove(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || !TERMINAL_STATUSES.has(task.status)) return false;
    this.tasks.delete(id);
    this.emit("task-removed", task);
    return true;
  }

  clearFinished(): number {
    const ids = [...this.tasks.values()]
      .filter((task) => TERMINAL_STATUSES.has(task.status))
      .map((task) => task.id);
    for (const id of ids) this.remove(id);
    return ids.length;
  }

  waitForIdle(): Promise<void> {
    if (!this.queue.length && !this.controllers.size) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  waitForTask(id: string): Promise<AgentTask> {
    const task = this.tasks.get(id);
    if (!task) return Promise.reject(new Error(`unknown task id: ${id}`));
    if (TERMINAL_STATUSES.has(task.status)) return Promise.resolve(cloneTask(task));
    return new Promise((resolve) => {
      const waiters = this.taskWaiters.get(id) ?? new Set();
      waiters.add(resolve);
      this.taskWaiters.set(id, waiters);
    });
  }

  private drain(): void {
    while (this.controllers.size < this.maxConcurrency && this.queue.length) {
      const id = this.queue.shift()!;
      const task = this.tasks.get(id);
      if (!task || task.status !== "queued") continue;
      this.start(task);
    }
    this.resolveIdleIfNeeded();
  }

  private start(task: AgentTask): void {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    task.status = "running";
    task.startedAt = this.timestamp();
    task.updatedAt = task.startedAt;
    this.appendProgress(task, { phase: "starting", message: "任务已启动" });
    this.emit("task-updated", task);

    const report = (
      progress: Omit<AgentTaskProgress, "sequence" | "at">,
    ) => {
      if (task.status !== "running") return;
      task.updatedAt = this.timestamp();
      this.appendProgress(task, progress);
      this.emit("task-updated", task);
    };

    void Promise.resolve()
      .then(() => this.runner(cloneTask(task), {
        signal: controller.signal,
        report,
      }))
      .then((result) => {
        if (controller.signal.aborted) {
          this.finish(task, "cancelled");
          return;
        }
        task.result = result ?? "";
        this.finish(task, "completed");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error as Error)?.name === "AbortError") {
          this.finish(task, "cancelled");
          return;
        }
        task.error = error instanceof Error ? error.message : String(error);
        this.finish(task, "failed");
      })
      .finally(() => {
        this.controllers.delete(task.id);
        this.drain();
      });
  }

  private finish(
    task: AgentTask,
    status: "completed" | "failed" | "cancelled",
  ): void {
    const now = this.timestamp();
    task.status = status;
    task.finishedAt = now;
    task.updatedAt = now;
    this.appendProgress(task, {
      phase: status,
      message: status === "completed"
        ? "任务已完成"
        : status === "cancelled"
          ? "任务已取消"
          : task.error ?? "任务执行失败",
    });
    this.emit("task-updated", task);
    const waiters = this.taskWaiters.get(task.id);
    if (waiters) {
      const snapshot = cloneTask(task);
      for (const resolve of waiters) resolve(snapshot);
      this.taskWaiters.delete(task.id);
    }
  }

  private appendProgress(
    task: AgentTask,
    progress: Omit<AgentTaskProgress, "sequence" | "at">,
  ): void {
    const previous = task.events[task.events.length - 1];
    task.events.push({
      ...progress,
      sequence: (previous?.sequence ?? 0) + 1,
      at: this.timestamp(),
    });
    if (task.events.length > this.maxEventsPerTask) {
      task.events.splice(0, task.events.length - this.maxEventsPerTask);
    }
  }

  private emit(
    type: AgentTaskSchedulerEvent["type"],
    task: AgentTask,
  ): void {
    const event = { type, task: cloneTask(task) } as AgentTaskSchedulerEvent;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("AgentTaskScheduler listener failed", error);
      }
    }
  }

  private resolveIdleIfNeeded(): void {
    if (this.queue.length || this.controllers.size) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
