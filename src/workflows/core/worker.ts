import type { Driver } from "../../db";
import type { InstagramClient } from "../../instagram/client";
import { claimRun, completeHandler, failHandler, type DeferredWrite, type WorkflowDefinition } from "./engine";
import { ALL_HANDLERS, selectedHandlers, type HandlerSelection } from "./selection";
import { WORKFLOWS } from "../index";

export interface WorkerOptions {
  db: Driver;
  instagram: InstagramClient;
  workflows?: readonly WorkflowDefinition[];
  /** Which workflow:state handlers this worker runs (default: all). See selectHandlers. */
  handles?: HandlerSelection;
  workerId?: string;
  now?: () => number;
  leaseMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
}

export type TickResult =
  | { status: "idle" }
  | { status: "advanced"; workflow: string; runId: string; from: string }
  | { status: "failed"; workflow: string; runId: string; from: string; error: string }
  | { status: "lease_lost"; workflow: string; runId: string; from: string };

export function createWorker(opts: WorkerOptions) {
  // Only the workflows and states this instance is configured to handle.
  const plan = selectedHandlers(opts.workflows ?? WORKFLOWS, opts.handles ?? ALL_HANDLERS);
  const workerId = opts.workerId ?? crypto.randomUUID();
  const now = opts.now ?? Date.now;
  const leaseMs = opts.leaseMs ?? 60_000;
  const retryDelayMs = opts.retryDelayMs ?? 30_000;
  const maxAttempts = opts.maxAttempts ?? 5;
  let next = 0; // round-robin start, so one busy workflow cannot starve the others

  /** Claim one run of any workflow and execute its state handler. */
  async function tick(): Promise<TickResult> {
    for (let i = 0; i < plan.length; i++) {
      const { workflow: def, states } = plan[(next + i) % plan.length]!;
      const run = await claimRun(opts.db, def, { workerId, now: now(), leaseMs, states });
      if (!run) continue;
      next = (next + i + 1) % plan.length;
      const from = run.state;
      const base = { workflow: def.name, runId: run.id, from };
      // Writes the handler defers (e.g. starting another workflow) commit with its new state.
      const deferred: DeferredWrite[] = [];
      try {
        const result = await def.handlers[from]!(run, { instagram: opts.instagram, db: opts.db, defer: (w) => void deferred.push(w) });
        const ok = await completeHandler(opts.db, def, run, result, deferred, { workerId, now: now() });
        return { status: ok ? "advanced" : "lease_lost", ...base };
      } catch (err) {
        // The handler or one of its deferred writes failed. completeHandler's transaction rolled
        // back, so the run is unchanged and still leased: record the failure and retry later.
        const error = err instanceof Error ? err.message : String(err);
        await failHandler(opts.db, def, run, { workerId, error, now: now(), retryDelayMs, maxAttempts });
        return { status: "failed", ...base, error };
      }
    }
    return { status: "idle" };
  }

  /** Tick until no ready work is left. Returns the number of handlers executed. */
  async function drain(limit = 1000): Promise<number> {
    let n = 0;
    while (n < limit && (await tick()).status !== "idle") n++;
    return n;
  }

  /** What this worker handles, e.g. for a startup log line. */
  const handles = plan.map((p) => ({ workflow: p.workflow.name, states: p.states }));

  return { workerId, handles, tick, drain };
}
