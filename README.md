# Comment-to-DM automations: Blotato take-home

When someone comments "pricing" on a customer's Instagram post, the system replies to the comment,
DMs the commenter asking for their email, waits for the answer, validates it, and sends a DM with a
link.

It's written in Bun and TypeScript, with plain SQL on SQLite or Postgres. The tests are the source
of truth. Everything not described here is in the code, so feel free to check it.
`ASSUMPTIONS.md` lists every decision and assumption with its reason.

```bash
bun install
bun run processor                 # HTTP triggers + worker, SQLite at data/app.db (migrates on start)
bun test                          # 167 tests; add TEST_POSTGRES_URL=... to run them on Postgres too
bun run test:load                 # several real processes on one database
```

## My decisions

- **A simple state machine.** Each automation run is a row with a `state`. A step changes the
  state, and the next step can start immediately on its trigger: a new comment, a new message, or
  "the previous step finished".
- **Two kinds of workflow, to avoid over-generalizing:** **comment** and **direct message**. Each
  kind has its own table and keys (commenter and comment, or the person we're talking to), which
  makes filtering and routing simple. A kind can hold several workflows, told apart by a
  `workflow` column.
  - The brief's flow is two workflows: `receive_dm_comment` → `direct_message_after_comment`.
  - The first one starts the second explicitly, through a function call.
- **Every step runs independently**, so steps run in parallel and concurrently. Even the smallest
  step can run on a different machine, and machines can be combined however you like. For example:
  - only one machine has access to Instagram, and another to other social networks
  - an expensive operation (video generation, a GPU job) runs only on the machine built for it,
    which only spends time on the steps that need it

  This is set at startup with `--handle` (e.g. `--handle @comments`, `--handle
  direct_message_after_comment:awaiting_email`). Roles are defined in `src/workflows/groups.ts`.
- **Triggers only record events.** Processing happens in the steps. Triggers never parse messages
  or call Instagram.
- **The DM is sent before the comment reply**, so "Sent you a DM!" is only posted once the DM has
  actually gone out.
- **Data decisions:**
  - The Instagram ID is the account's primary key, which avoids joins.
  - Tenants and accounts are many-to-many.
  - `state` is indexed text, and the extra data goes in a JSON `metadata` column.
  - Inbound DMs get their own table, which keeps a history of what people wrote.
- **Plain SQL, no ORM.** SQL is good enough.

## Architecture: an event queue built in the database

```
 trigger source ──► triggers (record event) ──► DB: runs + messages ──► workers × N (one step each) ──► Instagram
 (HTTP / queue)                                  (= the queue)           (any machine, any role)
```

**Triggers don't have to be HTTP.** The HTTP endpoints (`/triggers/comment(s)`,
`/triggers/message(s)`) are just one input. The same functions (`onComments`, `onMessages`) can be
fed by a queue consumer (SQS, Kafka, Pub/Sub) or by Meta webhooks behind an adapter.

**This implementation uses only the database.** The run tables *are* the queue:
- A run waiting in a state is a pending event for that state's handler.
- A worker leases it with a conditional update.
- The handler's result and everything it starts commit in one transaction.

With nothing but a database we get durability, ordering, retries and exactly-one-worker-per-step.

**With a real event queue, the logic stays the same.** Each step consumes an event ("run X entered
state S"), does its work, records the new state and publishes the next event. Starting another
workflow is just publishing its first event. The state machines, handlers, roles (one consumer
group per role) and tests carry over unchanged. Only the transport changes: workers would be
pushed events instead of polling the tables. What's built here is essentially that event queue,
implemented in the database.

## Data model

```
tenants, instagram_accounts (instagram_id PK, username), tenant_instagram_accounts (many-to-many)
instagram_account_workflows (account, workflow)          a customer enables an automation on their account
comment_workflow_runs        (workflow, account, commenter_user_id, comment_id, state, metadata, lease cols)
direct_message_workflow_runs (workflow, account, dm_user_id, state, metadata, lease cols)
direct_message_workflow_messages (run_id, text, received_at, processed_at)
```

## Execution model

```
receive_dm_comment:            comment contains "pricing" → comment_received → (DM asking for email, start DM workflow)
                               → dm_sent → (reply "Sent you a DM!") → completed
direct_message_after_comment:  awaiting_email + new messages → valid email → email_received → (DM with link) → completed
                               invalid → re-prompt DM → awaiting_email;  3rd invalid → invalid_email (final)
```

A worker loop:
1. Leases a ready run (its workflow is enabled and its state has a handler).
2. Runs the handler.
3. Commits the new state together with the queued writes.
4. On failure, retries after a delay, and after 5 attempts the run moves to `failed`.

## Reliability and concurrency

- **One worker per step:** a lease (`locked_by`, `locked_until`) and a `version` column ensure that
  only one worker runs a step. If a worker crashes, its lease expires and another worker picks the
  step up.
- **Atomic commits:** a new state, the messages it consumed, and any workflow it starts commit
  together, or not at all.
- **Deduplication:** `UNIQUE (workflow, comment_id)` absorbs webhook retries, and
  `UNIQUE (workflow, account, commenter)` ensures nobody is messaged twice.
- **Batches:** comments and messages can be sent in batches, handled in one transaction with
  chunked SQL.
- **Proven under load:** the load tests start several processes, check that every Instagram call
  happens exactly once across them, and check that roles are respected.
- **Outbound calls are at least once:** if a worker crashes after Instagram accepted a call but
  before the commit, the call is repeated.

## Assumptions, limitations and what I'd improve

- **Instagram itself is out of scope.** Webhook parsing and the real API client are assumed to
  exist already, so this repo uses a dry-run client.
- **Many parts are assumptions, and some of them can be argued.** For example: Instagram IDs are
  unique and stable, Meta user IDs can be trusted, someone already engaged is never messaged again,
  and the keyword is matched on whole words. Each one is in `ASSUMPTIONS.md`, marked Decided or
  Assumed.
- **Migrations could be done better.** For example, nothing guards against several instances
  migrating at once, and there's no rollback.
- **Some parts of the code deserve another review pass.** Overall I think the solution is already
  good.

## How this was built

The architecture and design decisions are mine, made step by step. The code, tests and
documentation were written by Claude Code (Anthropic) following my instructions. The AI made
mistakes along the way, and I reviewed each step and fixed some of them. I also edited some files
myself. I saw no point in writing the code by hand unless the agent couldn't get a specific piece of
logic right.
