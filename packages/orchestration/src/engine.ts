import { DBOS } from '@dbos-inc/dbos-sdk';

/**
 * The orchestrator abstraction — docs/module4.md §9: "Keep orchestration behind
 * packages/orchestration so the choice stays reversible." Decision D-13 (PROJECT.md §25):
 * DBOS Transact (Postgres-native, MIT) for Phase 1, consumed not rebuilt (D-06). A Temporal
 * adapter implements the same interface if the choice is revisited.
 *
 * Semantics a workflow can rely on, whichever engine:
 *   · a workflow with a given id runs at most once concurrently and survives process death:
 *     on restart it is re-executed from the top, and completed `step`s return their recorded
 *     results instead of running again
 *   · `recv` is a durable wait for a message sent with `send` (approvals, clarifications,
 *     replans); `sleep` is a durable timer (holds, M6)
 *   · the workflow body must be deterministic apart from steps and recv/sleep results
 */

export interface StepOptions {
  /**
   * Retries of a step that THREW (infrastructure: the database blipped). Never set on a step
   * that performs a side effect — those return their failures as values and are at-most-once.
   */
  retries?: number;
}

export interface DurableContext {
  readonly workflowId: string;
  step<T>(name: string, fn: () => Promise<T>, options?: StepOptions): Promise<T>;
  recv<T>(topic: string, timeoutSeconds: number): Promise<T | null>;
  sleep(ms: number): Promise<void>;
  now(): Promise<number>;
}

export type WorkflowFn<A extends unknown[], R> = (ctx: DurableContext, ...args: A) => Promise<R>;

export interface Orchestrator {
  register<A extends unknown[], R>(name: string, fn: WorkflowFn<A, R>): void;
  start<A extends unknown[]>(name: string, workflowId: string, ...args: A): Promise<void>;
  send(workflowId: string, topic: string, message: unknown): Promise<void>;
  cancel(workflowId: string): Promise<void>;
  status(workflowId: string): Promise<string | null>;
  result<R>(workflowId: string, timeoutSeconds?: number): Promise<R | null>;
  launch(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface DbosOptions {
  appName: string;
  systemDatabaseUrl: string;
  logLevel?: string;
}

const dbosContext = (workflowId: string): DurableContext => ({
  workflowId,
  step: (name, fn, options) =>
    DBOS.runStep(fn, {
      name,
      ...(options?.retries ? { retriesAllowed: true, maxAttempts: options.retries + 1, intervalSeconds: 0.5, backoffRate: 2 } : {}),
    }),
  recv: (topic, timeoutSeconds) => DBOS.recv(topic, timeoutSeconds),
  sleep: (ms) => DBOS.sleep(ms),
  now: () => DBOS.now(),
});

/** DBOS is a process-wide singleton: one DbosOrchestrator per process. */
export class DbosOrchestrator implements Orchestrator {
  private readonly workflows = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  private launched = false;

  constructor(private readonly options: DbosOptions) {}

  register<A extends unknown[], R>(name: string, fn: WorkflowFn<A, R>): void {
    if (this.launched) throw new Error('register workflows before launch()');
    const wrapped = DBOS.registerWorkflow(
      async (...args: A) => fn(dbosContext(DBOS.workflowID ?? 'unknown'), ...args),
      { name },
    );
    this.workflows.set(name, wrapped as (...args: unknown[]) => Promise<unknown>);
  }

  async launch(): Promise<void> {
    DBOS.setConfig({ name: this.options.appName, systemDatabaseUrl: this.options.systemDatabaseUrl, logLevel: this.options.logLevel ?? 'warn' });
    await DBOS.launch(); // recovers every pending workflow of this application
    this.launched = true;
  }

  async shutdown(): Promise<void> {
    if (this.launched) await DBOS.shutdown();
    this.launched = false;
  }

  async start<A extends unknown[]>(name: string, workflowId: string, ...args: A): Promise<void> {
    const wf = this.workflows.get(name);
    if (!wf) throw new Error(`no workflow ${name}`);
    // Same id twice is a no-op in DBOS: a run cannot be started twice.
    await DBOS.startWorkflow(wf, { workflowID: workflowId })(...args);
  }

  async send(workflowId: string, topic: string, message: unknown): Promise<void> {
    await DBOS.send(workflowId, message, topic);
  }

  async cancel(workflowId: string): Promise<void> {
    await DBOS.cancelWorkflow(workflowId);
  }

  async status(workflowId: string): Promise<string | null> {
    return (await DBOS.getWorkflowStatus(workflowId))?.status ?? null;
  }

  async result<R>(workflowId: string, timeoutSeconds = 30): Promise<R | null> {
    return DBOS.getResult<R>(workflowId, timeoutSeconds);
  }
}
