import type { Migration } from "./types";

/**
 * Ordered schema migrations. Append new entries; never edit applied ones.
 *
 * Workflow run tables share these columns:
 * - `workflow`: which workflow the run belongs to; one table can hold several workflows of a kind
 *   (e.g. direct_message_workflow_runs holds every direct message workflow).
 * - `state`: the current state as plain text, indexed.
 * - `metadata`: free-form JSON for extra data (collected email, messages, tokens spent, ...).
 * - `version`: guards concurrent writes.
 * - `locked_by` / `locked_until`: a lease so only one worker processes a run at a time.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    // See ASSUMPTIONS.md: the Instagram ID is the account's primary key.
    name: "create_tenants_and_instagram_accounts",
    up: {
      sqlite: `
        CREATE TABLE tenants (
          id   TEXT PRIMARY KEY CHECK (length(id) = 36),
          name TEXT NOT NULL
        );
        CREATE TABLE instagram_accounts (
          instagram_id TEXT PRIMARY KEY,
          username     TEXT NOT NULL
        );
        CREATE TABLE tenant_instagram_accounts (
          tenant_id            TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
          instagram_account_id TEXT NOT NULL REFERENCES instagram_accounts (instagram_id) ON DELETE CASCADE,
          PRIMARY KEY (tenant_id, instagram_account_id)
        );
        CREATE INDEX tenant_instagram_accounts_account_idx ON tenant_instagram_accounts (instagram_account_id);
      `,
      postgres: `
        CREATE TABLE tenants (
          id   UUID PRIMARY KEY,
          name TEXT NOT NULL
        );
        CREATE TABLE instagram_accounts (
          instagram_id TEXT PRIMARY KEY,
          username     TEXT NOT NULL
        );
        CREATE TABLE tenant_instagram_accounts (
          tenant_id            UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
          instagram_account_id TEXT NOT NULL REFERENCES instagram_accounts (instagram_id) ON DELETE CASCADE,
          PRIMARY KEY (tenant_id, instagram_account_id)
        );
        CREATE INDEX tenant_instagram_accounts_account_idx ON tenant_instagram_accounts (instagram_account_id);
      `,
    },
  },
  {
    name: "create_workflow_runs",
    up: {
      sqlite: `
        CREATE TABLE comment_workflow_runs (
          id                   TEXT PRIMARY KEY CHECK (length(id) = 36),
          instagram_account_id TEXT NOT NULL REFERENCES instagram_accounts (instagram_id) ON DELETE CASCADE,
          workflow             TEXT NOT NULL,
          commenter_user_id    TEXT NOT NULL,
          comment_id           TEXT NOT NULL,
          state                TEXT NOT NULL,
          metadata             TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
          version              INTEGER NOT NULL DEFAULT 0,
          attempts             INTEGER NOT NULL DEFAULT 0,
          last_error           TEXT,
          locked_by            TEXT,
          locked_until         INTEGER,
          created_at           INTEGER NOT NULL,
          updated_at           INTEGER NOT NULL,
          UNIQUE (workflow, comment_id),
          UNIQUE (workflow, instagram_account_id, commenter_user_id)
        );
        CREATE INDEX comment_workflow_runs_state_idx ON comment_workflow_runs (workflow, state, locked_until);

        CREATE TABLE direct_message_workflow_runs (
          id                   TEXT PRIMARY KEY CHECK (length(id) = 36),
          instagram_account_id TEXT NOT NULL REFERENCES instagram_accounts (instagram_id) ON DELETE CASCADE,
          workflow             TEXT NOT NULL,
          dm_user_id           TEXT NOT NULL,
          state                TEXT NOT NULL,
          metadata             TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
          version              INTEGER NOT NULL DEFAULT 0,
          attempts             INTEGER NOT NULL DEFAULT 0,
          last_error           TEXT,
          locked_by            TEXT,
          locked_until         INTEGER,
          created_at           INTEGER NOT NULL,
          updated_at           INTEGER NOT NULL
        );
        CREATE INDEX direct_message_workflow_runs_pair_idx ON direct_message_workflow_runs (instagram_account_id, dm_user_id);
        CREATE INDEX direct_message_workflow_runs_state_idx ON direct_message_workflow_runs (workflow, state, locked_until);
      `,
      postgres: `
        CREATE TABLE comment_workflow_runs (
          id                   UUID PRIMARY KEY,
          instagram_account_id TEXT NOT NULL REFERENCES instagram_accounts (instagram_id) ON DELETE CASCADE,
          workflow             TEXT NOT NULL,
          commenter_user_id    TEXT NOT NULL,
          comment_id           TEXT NOT NULL,
          state                TEXT NOT NULL,
          metadata             JSONB NOT NULL DEFAULT '{}',
          version              INTEGER NOT NULL DEFAULT 0,
          attempts             INTEGER NOT NULL DEFAULT 0,
          last_error           TEXT,
          locked_by            TEXT,
          locked_until         BIGINT,
          created_at           BIGINT NOT NULL,
          updated_at           BIGINT NOT NULL,
          UNIQUE (workflow, comment_id),
          UNIQUE (workflow, instagram_account_id, commenter_user_id)
        );
        CREATE INDEX comment_workflow_runs_state_idx ON comment_workflow_runs (workflow, state, locked_until);

        CREATE TABLE direct_message_workflow_runs (
          id                   UUID PRIMARY KEY,
          instagram_account_id TEXT NOT NULL REFERENCES instagram_accounts (instagram_id) ON DELETE CASCADE,
          workflow             TEXT NOT NULL,
          dm_user_id           TEXT NOT NULL,
          state                TEXT NOT NULL,
          metadata             JSONB NOT NULL DEFAULT '{}',
          version              INTEGER NOT NULL DEFAULT 0,
          attempts             INTEGER NOT NULL DEFAULT 0,
          last_error           TEXT,
          locked_by            TEXT,
          locked_until         BIGINT,
          created_at           BIGINT NOT NULL,
          updated_at           BIGINT NOT NULL
        );
        CREATE INDEX direct_message_workflow_runs_pair_idx ON direct_message_workflow_runs (instagram_account_id, dm_user_id);
        CREATE INDEX direct_message_workflow_runs_state_idx ON direct_message_workflow_runs (workflow, state, locked_until);
      `,
    },
  },
  {
    // A row means the workflow is enabled for that Instagram account; no row means disabled.
    name: "create_instagram_account_workflows",
    up: {
      sqlite: `
        CREATE TABLE instagram_account_workflows (
          instagram_account_id TEXT NOT NULL REFERENCES instagram_accounts (instagram_id) ON DELETE CASCADE,
          workflow             TEXT NOT NULL,
          enabled_at           INTEGER NOT NULL,
          PRIMARY KEY (instagram_account_id, workflow)
        );
      `,
      postgres: `
        CREATE TABLE instagram_account_workflows (
          instagram_account_id TEXT NOT NULL REFERENCES instagram_accounts (instagram_id) ON DELETE CASCADE,
          workflow             TEXT NOT NULL,
          enabled_at           BIGINT NOT NULL,
          PRIMARY KEY (instagram_account_id, workflow)
        );
      `,
    },
  },
  {
    // Inbound DMs routed to a direct message run, kept after processing as history.
    // `id` is auto-increment so messages keep their arrival order, even within one batch.
    name: "create_direct_message_workflow_messages",
    up: {
      sqlite: `
        CREATE TABLE direct_message_workflow_messages (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id       TEXT NOT NULL REFERENCES direct_message_workflow_runs (id) ON DELETE CASCADE,
          text         TEXT NOT NULL,
          received_at  INTEGER NOT NULL,
          processed_at INTEGER
        );
        CREATE INDEX direct_message_workflow_messages_pending_idx
          ON direct_message_workflow_messages (run_id, id) WHERE processed_at IS NULL;
      `,
      postgres: `
        CREATE TABLE direct_message_workflow_messages (
          id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          run_id       UUID NOT NULL REFERENCES direct_message_workflow_runs (id) ON DELETE CASCADE,
          text         TEXT NOT NULL,
          received_at  BIGINT NOT NULL,
          processed_at BIGINT
        );
        CREATE INDEX direct_message_workflow_messages_pending_idx
          ON direct_message_workflow_messages (run_id, id) WHERE processed_at IS NULL;
      `,
    },
  },
];
