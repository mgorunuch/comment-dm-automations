import type { Driver } from "../../db";
import { SQL_CHUNK, chunk, placeholders } from "../../utils/sql";
import { enabledLookup } from "../core/enabled";
import {
  insertRun,
  toRun,
  type HandlerContext,
  type Metadata,
  type Run,
  type StateHandler,
  type WorkflowContext,
  type WorkflowDefinition,
} from "../core/engine";

/**
 * Direct message workflow kind. Every direct message workflow stores its runs in
 * direct_message_workflow_runs, keyed by the user we talk to, and shares one inbound contract:
 *
 * - The message trigger never parses and never changes a run. It stores the raw text in
 *   direct_message_workflow_messages, linked to the run it was routed to.
 * - A message goes to exactly one run: the latest run, across all enabled direct message
 *   workflows of the account, that is in one of its workflow's listening states.
 * - A run in a listening state is picked up by the worker only when it has unprocessed
 *   messages. Its handler reads them with takeMessages, which marks them processed when the
 *   handler's result commits.
 */
export const DIRECT_MESSAGE_KIND = "direct_message";
export const DIRECT_MESSAGE_RUNS_TABLE = "direct_message_workflow_runs";
export const DIRECT_MESSAGES_TABLE = "direct_message_workflow_messages";

export interface DirectMessageWorkflow extends WorkflowDefinition {
  kind: typeof DIRECT_MESSAGE_KIND;
  /** States waiting for the user's reply. Their handlers run once a message has arrived. */
  listeningStates: readonly string[];
}

export function defineDirectMessageWorkflow(spec: {
  name: string;
  /** States waiting for the user's reply; each needs a handler, which reads messages with takeMessages. */
  listeningStates: readonly string[];
  handlers: Readonly<Record<string, StateHandler>>;
}): DirectMessageWorkflow {
  const missing = spec.listeningStates.filter((s) => !spec.handlers[s]);
  if (missing.length) throw new Error(`${spec.name}: listening states without a handler: ${missing.join(", ")}`);
  return {
    kind: DIRECT_MESSAGE_KIND,
    name: spec.name,
    table: DIRECT_MESSAGE_RUNS_TABLE,
    columns: ["dm_user_id"],
    listeningStates: spec.listeningStates,
    handlers: spec.handlers,
    // A listening run is only ready once a message has arrived for it.
    claimFilter: (param) =>
      `r.state NOT IN (${spec.listeningStates.map(param).join(", ")})
       OR EXISTS (SELECT 1 FROM ${DIRECT_MESSAGES_TABLE} m WHERE m.run_id = r.id AND m.processed_at IS NULL)`,
  };
}

/**
 * Start a run of a direct message workflow with `dmUserId`. The run is created when the
 * context commits (with the calling handler's new state, or in withWorkflowContext).
 */
export function startDirectMessageWorkflow(
  ctx: WorkflowContext,
  workflow: DirectMessageWorkflow,
  input: { instagramAccountId: string; dmUserId: string; state: string; metadata?: Metadata },
): void {
  ctx.defer((tx, now) =>
    insertRun(
      tx,
      workflow,
      { instagramAccountId: input.instagramAccountId, columns: { dm_user_id: input.dmUserId }, state: input.state, metadata: input.metadata },
      now,
    ),
  );
}

/**
 * For listening-state handlers: the run's unprocessed messages, oldest first. They are marked
 * processed in the same transaction as the handler's result, so if the handler fails or loses
 * its lease they are handed over again next time.
 */
export async function takeMessages(run: Run, ctx: HandlerContext): Promise<string[]> {
  const rows = await ctx.db.query<{ id: unknown; text: string }>(
    `SELECT id, text FROM ${DIRECT_MESSAGES_TABLE} WHERE run_id = $1 AND processed_at IS NULL ORDER BY id`,
    [run.id],
  );
  const ids = rows.map((r) => Number(r.id));
  if (ids.length > 0) {
    ctx.defer(async (tx, now) => {
      for (const part of chunk(ids, SQL_CHUNK)) {
        await tx.query(`UPDATE ${DIRECT_MESSAGES_TABLE} SET processed_at = $1 WHERE id IN (${placeholders(2, part.length)})`, [
          now,
          ...part,
        ]);
      }
    });
  }
  return rows.map((r) => r.text);
}

export interface MessageTrigger {
  /** Our account's Instagram ID (the DM recipient). */
  instagramAccountId: string;
  /** Meta user ID of the sender. */
  fromUserId: string;
  text: string;
}

export type MessageResult =
  | { accepted: true; workflow: string; runId: string }
  | { accepted: false; reason: "workflow_disabled" | "no_waiting_run" };

/** Store one message. Same as a batch of one. */
export async function handleMessage(
  db: Driver,
  workflows: readonly DirectMessageWorkflow[],
  t: MessageTrigger,
  now = Date.now(),
): Promise<MessageResult> {
  return (await handleMessages(db, workflows, [t], now))[0]!;
}

const pairKey = (account: string, user: string) => `${account}\u0000${user}`;

/**
 * Store a batch of messages, in one transaction. No parsing, and no run is changed. Each message
 * is routed to the latest listening run of its account/user pair among the account's enabled
 * direct message workflows, and stored in input order. Returns one result per message, in input
 * order.
 */
export async function handleMessages(
  db: Driver,
  workflows: readonly DirectMessageWorkflow[],
  triggers: readonly MessageTrigger[],
  now = Date.now(),
): Promise<MessageResult[]> {
  if (triggers.length === 0) return [];
  return db.transaction(async (tx) => {
    const isEnabled = await enabledLookup(tx, triggers.map((t) => t.instagramAccountId));

    // Latest listening run per conversation: one query per chunk of pairs, newest first.
    const pairs = new Map<string, { account: string; user: string }>();
    for (const t of triggers) pairs.set(pairKey(t.instagramAccountId, t.fromUserId), { account: t.instagramAccountId, user: t.fromUserId });
    const latest = new Map<string, Run>();
    for (const part of chunk([...pairs.values()], SQL_CHUNK / 2)) {
      const params: unknown[] = [];
      const p = (v: unknown) => (params.push(v), `$${params.length}`);
      const pairSql = part.map((x) => `(instagram_account_id = ${p(x.account)} AND dm_user_id = ${p(x.user)})`);
      const stateSql = workflows.map((w) => `(workflow = ${p(w.name)} AND state IN (${w.listeningStates.map(p).join(", ")}))`);
      const rows = await tx.query(
        `SELECT * FROM ${DIRECT_MESSAGE_RUNS_TABLE}
         WHERE (${pairSql.join(" OR ")}) AND (${stateSql.join(" OR ")})
         ORDER BY created_at DESC, id DESC`,
        params,
      );
      for (const row of rows) {
        const run = toRun(row);
        const key = pairKey(run.instagram_account_id, String(run.dm_user_id));
        if (!latest.has(key) && isEnabled(run.instagram_account_id, run.workflow as string)) latest.set(key, run);
      }
    }

    // Route every message, then store the routed ones in input order.
    const results: MessageResult[] = [];
    const routed: { runId: string; text: string }[] = [];
    for (const t of triggers) {
      const run = latest.get(pairKey(t.instagramAccountId, t.fromUserId));
      if (run) {
        routed.push({ runId: run.id, text: t.text });
        results.push({ accepted: true, workflow: run.workflow as string, runId: run.id });
      } else {
        const anyEnabled = workflows.some((w) => isEnabled(t.instagramAccountId, w.name));
        results.push({ accepted: false, reason: anyEnabled ? "no_waiting_run" : "workflow_disabled" });
      }
    }
    for (const part of chunk(routed, SQL_CHUNK)) {
      const params: unknown[] = [];
      const tuples = part.map((m) => {
        params.push(m.runId, m.text, now);
        return `($${params.length - 2}, $${params.length - 1}, $${params.length})`;
      });
      await tx.query(`INSERT INTO ${DIRECT_MESSAGES_TABLE} (run_id, text, received_at) VALUES ${tuples.join(", ")}`, params);
    }
    return results;
  });
}
