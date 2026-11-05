#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { databaseUrl, migrateDatabase, type Driver } from "../db";
import { createDryRunInstagramClient } from "../instagram/client";
import { selectHandlers, type HandlerSelection } from "../workflows/core/selection";
import { createWorker } from "../workflows/core/worker";
import { HANDLER_GROUPS } from "../workflows/groups";
import { WORKFLOWS } from "../workflows/index";
import { createApp } from "./app";

/**
 * One processor instance: the HTTP triggers and/or a worker. Run several against one database
 * (leases make that safe) and give each machine a role with --handle, for example:
 *
 *   bun run processor --no-worker                          # HTTP only
 *   bun run processor --no-http --handle @comments         # comment handlers only
 *   bun run processor --no-http --handle @direct-messages  # DM handlers only
 */
const { values } = parseArgs({
  options: {
    db: { type: "string" },
    port: { type: "string", default: process.env.PORT ?? "3000" },
    "poll-ms": { type: "string", default: process.env.POLL_MS ?? "1000" },
    "no-worker": { type: "boolean", default: false },
    "no-http": { type: "boolean", default: false },
    /** Comma-separated handler selectors or @groups; repeatable. Default: every handler. */
    handle: { type: "string", multiple: true, default: process.env.WORKER_HANDLE ? [process.env.WORKER_HANDLE] : [] },
    "dry-run-latency-ms": { type: "string", default: process.env.DRY_RUN_LATENCY_MS ?? "0" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (values["no-worker"] && values["no-http"]) fail("Nothing to run: --no-worker and --no-http are both set.");

let handles: HandlerSelection;
try {
  handles = selectHandlers(values.handle, WORKFLOWS, HANDLER_GROUPS);
} catch (err) {
  fail((err as Error).message);
}

let db: Driver;
try {
  db = await migrateDatabase(databaseUrl(values.db));
} catch (err) {
  fail((err as Error).message);
}

const server = values["no-http"] ? undefined : Bun.serve({ port: Number(values.port), fetch: createApp(db).fetch });
if (server) console.log(`Processor listening on ${server.url} (${db.dialect})`);

// Leases in the run tables make it safe to run any number of workers against one database.
let stopping = false;
let loop: Promise<void> = Promise.resolve();
if (!values["no-worker"]) {
  const instagram = createDryRunInstagramClient({ latencyMs: Number(values["dry-run-latency-ms"]) });
  const worker = createWorker({ db, instagram, handles });
  const pollMs = Number(values["poll-ms"]);
  loop = (async () => {
    while (!stopping) {
      try {
        if ((await worker.drain()) === 0) await Bun.sleep(pollMs);
      } catch (err) {
        console.error("worker error:", err);
        await Bun.sleep(pollMs);
      }
    }
  })();
  const plan = worker.handles.map((h) => `${h.workflow}:${h.states.join("|")}`).join(", ") || "nothing";
  console.log(`Worker ${worker.workerId} polling every ${pollMs}ms, handling ${plan}`);
}

const shutdown = async () => {
  stopping = true;
  server?.stop();
  await loop;
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
