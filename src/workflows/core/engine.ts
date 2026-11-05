import { jsonParam, parseJson, type Driver, type Queryable } from "../../db";
import type { InstagramClient } from "../../instagram/client";
import { SQL_CHUNK, chunk } from "../../utils/sql";

/** Free-form data a run collects along the way (email, messages, tokens spent, ...). */
export type Metadata = Record<string, unknown>;

export type Run = {
  id: string;
  /** Our account's Instagram ID. */
  instagram_account_id: string;
  /** Current state of the state machine. */
  state: string;
  metadata: Metadata;
  version: number;
  attempts: number;
  last_error: string | null;
} & Record<string, unknown>;

/**
 * What a handler returns. It only ever changes the run being handled; anything else (such as
 * starting another workflow) goes through the context.
 */
export interface HandlerResult {
  state: string;
  /** Replaces the run's metadata when given; otherwise it is kept as is. */
  metadata?: Metadata;
}

/** A database write that must commit together with the current change. */
export type DeferredWrite = (tx: Queryable, now: number) => Promise<unknown>;

/**
 * Lets workflow code queue writes, such as starting another workflow, that commit in the same
 * transaction as the current change, or not at all.
 */
export interface WorkflowContext {
  defer(write: DeferredWrite): void;
}

/** Passed to state handlers. Deferred writes commit with the handler's new state and are dropped if the lease was lost. */
export interface HandlerContext extends WorkflowContext {
  instagram: InstagramClient;
  /** For reads only. Writes go through `defer`, so they commit with the handler's result. */
  db: Queryable;
}

/**
 * Run `fn` with a WorkflowContext outside a handler (e.g. to start a workflow manually), then
 * commit its deferred writes in one transaction.
 */
export async function withWorkflowContext<R>(
  db: Driver,
  fn: (ctx: WorkflowContext) => R | Promise<R>,
  now = Date.now(),
): Promise<R> {
  const writes: DeferredWrite[] = [];
  const out = await fn({ defer: (w) => void writes.push(w) });
  if (writes.length > 0) {
    await db.transaction(async (tx) => {
      for (const w of writes) await w(tx, now);
    });
  }
  return out;
}

export type StateHandler = (run: Run, ctx: HandlerContext) => Promise<HandlerResult>;

export interface WorkflowDefinition {
  name: string;
  table: string;
  /** Workflow-specific key columns besides instagram_account_id. */
  columns: readonly string[];
  /** Worker-driven state handlers, keyed by the state they run from. Other states only move on triggers. */
  handlers: Readonly<Record<string, StateHandler>>;
  /**
   * Extra SQL condition a run must meet to be claimed by a worker, besides having a handler for
   * its state. The run table is aliased `r`; bind values with `param`, which returns a placeholder.
   */
  claimFilter?: (param: (value: unknown) => string) => string;
}

/** Terminal state for a run whose handler kept failing; metadata.failedState records where. */
export const FAILED = "failed";

export function toRun(row: Record<string, unknown>): Run {
  return {
    ...row,
    id: String(row.id),
    instagram_account_id: String(row.instagram_account_id),
    state: String(row.state),
    metadata: parseJson<Metadata>(row.metadata),
    version: Number(row.version),
    attempts: Number(row.attempts),
    last_error: (row.last_error as string | null) ?? null,
  };
}

export interface NewRun {
  instagramAccountId: string;
  /** Values for the workflow's key columns. */
  columns: Record<string, string>;
  state: string;
  metadata?: Metadata;
}

/** Rows per multi-row INSERT: keeps the parameter count far below SQLite's and Postgres' limits. */

/** Insert a run. Returns its id, or undefined if a unique constraint already holds one. */
export async function insertRun(q: Queryable, def: WorkflowDefinition, run: NewRun, now: number): Promise<string | undefined> {
  return (await insertRuns(q, def, [run], now))[0];
}

/**
 * Insert many runs with multi-row INSERTs. Returns one entry per input, in order: the new
 * run's id, or undefined where a unique constraint (in the table or earlier in this batch)
 * already holds one.
 */
export async function insertRuns(
  q: Queryable,
  def: WorkflowDefinition,
  runs: readonly NewRun[],
  now: number,
): Promise<(string | undefined)[]> {
  for (const run of runs) {
    const missing = def.columns.filter((c) => !(c in run.columns));
    if (missing.length) throw new Error(`${def.name}: missing columns ${missing.join(", ")}`);
  }
  const columns = ["id", "workflow", "instagram_account_id", ...def.columns, "state", "metadata", "created_at", "updated_at"];
  const ids = runs.map(() => crypto.randomUUID());
  const inserted = new Set<string>();
  let offset = 0;
  for (const part of chunk(runs, SQL_CHUNK)) {
    const params: unknown[] = [];
    const tuples = part.map((run, j) => {
      const values = [
        ids[offset + j],
        def.name,
        run.instagramAccountId,
        ...def.columns.map((c) => run.columns[c]),
        run.state,
        JSON.stringify(run.metadata ?? {}),
        now,
        now,
      ];
      const first = params.length + 1;
      params.push(...values);
      const p = values.map((_, k) => `$${first + k}`);
      p[columns.indexOf("metadata")] = jsonParam(q.dialect, p[columns.indexOf("metadata")]!);
      return `(${p.join(", ")})`;
    });
    const rows = await q.query<{ id: unknown }>(
      `INSERT INTO ${def.table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}
       ON CONFLICT DO NOTHING
       RETURNING id`,
      params,
    );
    for (const r of rows) inserted.add(String(r.id));
    offset += part.length;
  }
  return ids.map((id) => (inserted.has(id) ? id : undefined));
}

export async function getRun(q: Queryable, def: WorkflowDefinition, id: string): Promise<Run | undefined> {
  const rows = await q.query(`SELECT * FROM ${def.table} WHERE id = $1 AND workflow = $2`, [id, def.name]);
  return rows[0] && toRun(rows[0]);
}

export interface RunFilter {
  instagramAccountId: string;
  /** Values for the workflow's key columns. */
  columns?: Record<string, string>;
  /** Only runs currently in one of these states. */
  states?: readonly string[];
}

/** Runs of this workflow matching the filter, oldest first. */
export async function findRuns(q: Queryable, def: WorkflowDefinition, where: RunFilter): Promise<Run[]> {
  const { sql, params } = runFilter(def, where);
  const rows = await q.query(`SELECT * FROM ${def.table} WHERE ${sql} ORDER BY created_at, id`, params);
  return rows.map(toRun);
}

/** The most recently created run of this workflow matching the filter. */
export async function findLatestRun(q: Queryable, def: WorkflowDefinition, where: RunFilter): Promise<Run | undefined> {
  const { sql, params } = runFilter(def, where);
  const rows = await q.query(`SELECT * FROM ${def.table} WHERE ${sql} ORDER BY created_at DESC, id DESC LIMIT 1`, params);
  return rows[0] && toRun(rows[0]);
}

function runFilter(def: WorkflowDefinition, where: RunFilter): { sql: string; params: unknown[] } {
  const params: unknown[] = [def.name, where.instagramAccountId];
  const conds = ["workflow = $1", "instagram_account_id = $2"];
  for (const [col, val] of Object.entries(where.columns ?? {})) {
    if (!def.columns.includes(col)) throw new Error(`${def.name}: unknown column ${col}`);
    params.push(val);
    conds.push(`${col} = $${params.length}`);
  }
  if (where.states) {
    if (where.states.length === 0) return { sql: "1 = 0", params };
    const first = params.length + 1;
    params.push(...where.states);
    conds.push(`state IN (${where.states.map((_, i) => `\$${first + i}`).join(", ")})`);
  }
  return { sql: conds.join(" AND "), params };
}

/**
 * Move a run to `state` with `metadata` if nobody changed it since it was read
 * (optimistic, via `version`). Used by triggers. Returns false if the run moved on meanwhile.
 * Releases any lease, so the new state is picked up right away; a worker still running a
 * handler for the old state will find the version changed and discard its result.
 */
export async function transition(
  q: Queryable,
  def: WorkflowDefinition,
  run: Run,
  next: { state: string; metadata: Metadata },
  now: number,
): Promise<boolean> {
  const rows = await q.query(
    `UPDATE ${def.table} SET state = $1, metadata = ${jsonParam(q.dialect, "$2")}, version = version + 1, updated_at = $3,
         locked_by = NULL, locked_until = NULL
     WHERE id = $4 AND version = $5 RETURNING id`,
    [next.state, JSON.stringify(next.metadata), now, run.id, run.version],
  );
  return rows.length > 0;
}

/**
 * Lease one run whose state has a handler. Candidates are read first, then taken with a
 * conditional UPDATE, so two workers racing for one row cannot both win.
 */
export async function claimRun(
  db: Driver,
  def: WorkflowDefinition,
  opts: {
    workerId: string;
    now: number;
    leaseMs: number;
    /** Only claim runs in these states (default: every state with a handler). */
    states?: readonly string[];
  },
): Promise<Run | undefined> {
  const states = (opts.states ?? Object.keys(def.handlers)).filter((s) => def.handlers[s]);
  if (states.length === 0) return undefined;
  const params: unknown[] = [opts.now, def.name];
  const param = (value: unknown) => (params.push(value), `$${params.length}`);
  const stateList = states.map(param).join(", ");
  const extra = def.claimFilter ? `AND (${def.claimFilter(param)})` : "";
  const candidates = await db.query<{ id: unknown; version: unknown }>(
    `SELECT r.id, r.version FROM ${def.table} r
     WHERE r.workflow = $2 AND r.state IN (${stateList}) AND (r.locked_until IS NULL OR r.locked_until <= $1)
       AND EXISTS (SELECT 1 FROM instagram_account_workflows w
                   WHERE w.instagram_account_id = r.instagram_account_id AND w.workflow = $2)
       ${extra}
     ORDER BY r.updated_at LIMIT 10`,
    params,
  );
  for (const c of candidates) {
    const won = await db.query(
      `UPDATE ${def.table} SET locked_by = $1, locked_until = $2
       WHERE id = $3 AND version = $4 AND (locked_until IS NULL OR locked_until <= $5)
       RETURNING *`,
      [opts.workerId, opts.now + opts.leaseMs, String(c.id), Number(c.version), opts.now],
    );
    if (won[0]) return toRun(won[0]);
  }
  return undefined;
}

/**
 * Store a handler result, release the lease and apply the handler's deferred writes, all in one transaction.
 * Returns false (and changes nothing) if the lease was lost to another worker.
 */
export async function completeHandler(
  db: Driver,
  def: WorkflowDefinition,
  run: Run,
  result: HandlerResult,
  deferred: readonly DeferredWrite[],
  opts: { workerId: string; now: number },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.query(
      `UPDATE ${def.table}
       SET state = $1, metadata = ${jsonParam(tx.dialect, "$2")}, version = version + 1, attempts = 0, last_error = NULL,
           locked_by = NULL, locked_until = NULL, updated_at = $3
       WHERE id = $4 AND version = $5 AND locked_by = $6
       RETURNING id`,
      [result.state, JSON.stringify(result.metadata ?? run.metadata), opts.now, run.id, run.version, opts.workerId],
    );
    if (rows.length === 0) return false;
    for (const write of deferred) await write(tx, opts.now);
    return true;
  });
}

/**
 * Record a failed handler: the run keeps its state and becomes claimable again after
 * `retryDelayMs`. Once `maxAttempts` is reached it moves to `failed`.
 */
export async function failHandler(
  db: Driver,
  def: WorkflowDefinition,
  run: Run,
  opts: { workerId: string; error: string; now: number; retryDelayMs: number; maxAttempts: number },
): Promise<void> {
  const failedMetadata: Metadata = { ...run.metadata, failedState: run.state };
  await db.query(
    `UPDATE ${def.table}
     SET attempts = attempts + 1, last_error = $1, locked_by = NULL, locked_until = $2, updated_at = $3,
         version = version + 1,
         state    = CASE WHEN attempts + 1 >= $4 THEN $5 ELSE state END,
         metadata = CASE WHEN attempts + 1 >= $4 THEN ${jsonParam(db.dialect, "$6")} ELSE metadata END
     WHERE id = $7 AND version = $8 AND locked_by = $9`,
    [opts.error, opts.now + opts.retryDelayMs, opts.now, opts.maxAttempts, FAILED, JSON.stringify(failedMetadata), run.id, run.version, opts.workerId],
  );
}
