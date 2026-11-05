import type { Driver } from "../src/db";

/** Deterministic seed data every test starts from. */
export const TENANTS = {
  acme: { id: "11111111-1111-4111-8111-111111111111", name: "Acme" },
  globex: { id: "22222222-2222-4222-8222-222222222222", name: "Globex" },
} as const;

export const INSTAGRAM_ACCOUNTS = {
  acmeOnly: { instagram_id: "17841400000000001", username: "acme_official" },
  globexOnly: { instagram_id: "17841400000000002", username: "globex_hq" },
  /** Linked to both tenants: exercises the many-to-many relation. */
  shared: { instagram_id: "17841400000000003", username: "joint_venture" },
} as const;

export const TENANT_INSTAGRAM_ACCOUNTS = [
  { tenant_id: TENANTS.acme.id, instagram_account_id: INSTAGRAM_ACCOUNTS.acmeOnly.instagram_id },
  { tenant_id: TENANTS.acme.id, instagram_account_id: INSTAGRAM_ACCOUNTS.shared.instagram_id },
  { tenant_id: TENANTS.globex.id, instagram_account_id: INSTAGRAM_ACCOUNTS.globexOnly.instagram_id },
  { tenant_id: TENANTS.globex.id, instagram_account_id: INSTAGRAM_ACCOUNTS.shared.instagram_id },
] as const;

/** Workflows enabled per account. `shared` has none, to exercise the disabled path. */
export const ENABLED_WORKFLOWS = [
  { instagram_account_id: INSTAGRAM_ACCOUNTS.acmeOnly.instagram_id, workflow: "receive_dm_comment" },
  { instagram_account_id: INSTAGRAM_ACCOUNTS.acmeOnly.instagram_id, workflow: "direct_message_after_comment" },
  { instagram_account_id: INSTAGRAM_ACCOUNTS.globexOnly.instagram_id, workflow: "receive_dm_comment" },
  { instagram_account_id: INSTAGRAM_ACCOUNTS.globexOnly.instagram_id, workflow: "direct_message_after_comment" },
] as const;

export async function seed(db: Driver): Promise<void> {
  for (const t of Object.values(TENANTS)) {
    await db.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [t.id, t.name]);
  }
  for (const a of Object.values(INSTAGRAM_ACCOUNTS)) {
    await db.query("INSERT INTO instagram_accounts (instagram_id, username) VALUES ($1, $2)", [a.instagram_id, a.username]);
  }
  for (const l of TENANT_INSTAGRAM_ACCOUNTS) {
    await db.query("INSERT INTO tenant_instagram_accounts (tenant_id, instagram_account_id) VALUES ($1, $2)", [
      l.tenant_id,
      l.instagram_account_id,
    ]);
  }
  for (const e of ENABLED_WORKFLOWS) {
    await db.query("INSERT INTO instagram_account_workflows (instagram_account_id, workflow, enabled_at) VALUES ($1, $2, 0)", [
      e.instagram_account_id,
      e.workflow,
    ]);
  }
}
