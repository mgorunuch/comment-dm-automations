import type { Queryable } from "../../db";
import { selectIn } from "../../utils/sql";

/** Enable a workflow for one of our Instagram accounts. Idempotent. */
export async function enableWorkflow(q: Queryable, instagramAccountId: string, workflow: string, now = Date.now()) {
  await q.query(
    `INSERT INTO instagram_account_workflows (instagram_account_id, workflow, enabled_at) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [instagramAccountId, workflow, now],
  );
}

/** Disable a workflow. Its in-flight runs pause until it is enabled again. */
export async function disableWorkflow(q: Queryable, instagramAccountId: string, workflow: string) {
  await q.query("DELETE FROM instagram_account_workflows WHERE instagram_account_id = $1 AND workflow = $2", [
    instagramAccountId,
    workflow,
  ]);
}

export async function isWorkflowEnabled(q: Queryable, instagramAccountId: string, workflow: string): Promise<boolean> {
  const rows = await q.query(
    "SELECT 1 FROM instagram_account_workflows WHERE instagram_account_id = $1 AND workflow = $2",
    [instagramAccountId, workflow],
  );
  return rows.length > 0;
}

export async function enabledWorkflows(q: Queryable, instagramAccountId: string): Promise<string[]> {
  const rows = await q.query<{ workflow: string }>(
    "SELECT workflow FROM instagram_account_workflows WHERE instagram_account_id = $1 ORDER BY workflow",
    [instagramAccountId],
  );
  return rows.map((r) => r.workflow);
}

/** Which (account, workflow) pairs are enabled, for many accounts in one (chunked) query. */
export async function enabledLookup(
  q: Queryable,
  instagramAccountIds: readonly string[],
): Promise<(instagramAccountId: string, workflow: string) => boolean> {
  const rows = await selectIn<{ instagram_account_id: string; workflow: string }>(
    q,
    (list) => `SELECT instagram_account_id, workflow FROM instagram_account_workflows WHERE instagram_account_id IN (${list})`,
    [],
    instagramAccountIds,
  );
  const enabled = new Set(rows.map((r) => `${r.instagram_account_id}\u0000${r.workflow}`));
  return (account, workflow) => enabled.has(`${account}\u0000${workflow}`);
}
