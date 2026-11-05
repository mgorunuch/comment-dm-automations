import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrateDatabase, type Driver } from "../src/db";
import type { DryRunCall } from "../src/instagram/client";
import { TEXTS } from "../src/workflows/texts";
import { INSTAGRAM_ACCOUNTS, seed } from "../tests/fixtures";
import { TARGETS } from "../tests/targets";
import { startInstance, waitFor, type Instance } from "./instances";

/**
 * Load tests: several processor processes on one database, as separate machines would run.
 * Sizes are tunable: LOAD_CONVERSATIONS (default 400), LOAD_WORKERS (default 4),
 * LOAD_LATENCY_MS (simulated Instagram latency per call, default 5).
 */
const CONVERSATIONS = Number(process.env.LOAD_CONVERSATIONS ?? 400);
const WORKERS = Number(process.env.LOAD_WORKERS ?? 4);
const LATENCY_MS = Number(process.env.LOAD_LATENCY_MS ?? 5);
const ACCOUNTS = [INSTAGRAM_ACCOUNTS.acmeOnly.instagram_id, INSTAGRAM_ACCOUNTS.globexOnly.instagram_id];

const workerArgs = (handle?: string) => [
  "--no-http",
  "--poll-ms",
  "20",
  "--dry-run-latency-ms",
  String(LATENCY_MS),
  ...(handle ? ["--handle", handle] : []),
];

/** The conversation plan: user i comments on one of our accounts; even users answer with a valid email. */
const users = Array.from({ length: CONVERSATIONS }, (_, i) => ({
  user: `load-user-${i}`,
  account: ACCOUNTS[i % ACCOUNTS.length]!,
  commentId: `load-comment-${i}`,
  reply: i % 2 === 0 ? `load-user-${i}@mail.com` : "no email, sorry",
}));

/** Every Instagram call the whole system must make exactly once for this plan. */
const expectedCalls = users
  .flatMap(({ user, account, commentId, reply }) => [
    `dm|${account}|${user}|${TEXTS.askEmail}`,
    `reply|${account}|${commentId}|${TEXTS.commentReply}`,
    reply.includes("@") ? `dm|${account}|${user}|${TEXTS.confirm(reply)}` : `dm|${account}|${user}|${TEXTS.retry.no_email}`,
  ])
  .sort();
const key = (c: DryRunCall) => (c.instagram === "dm" ? `dm|${c.account}|${c.recipient}|${c.text}` : `reply|${c.account}|${c.commentId}|${c.text}`);

describe.each(TARGETS)("$name", (target) => {
  let url: string;
  let cleanup: () => Promise<void>;
  let db: Driver;
  let instances: Instance[];

  beforeEach(async () => {
    ({ url, cleanup } = await target.fresh());
    db = await migrateDatabase(url);
    await seed(db);
    instances = [];
  });

  afterEach(async () => {
    await Promise.all(instances.map((i) => i.stop()));
    await db.close();
    await cleanup();
  });

  const start = (name: string, args: string[]) => {
    const instance = startInstance(name, url, args);
    instances.push(instance);
    return instance;
  };
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: number }>(sql, params))[0]!.n);
  const progress = async () =>
    JSON.stringify({
      comments: await db.query("SELECT state, COUNT(*) AS n FROM comment_workflow_runs GROUP BY state"),
      dms: await db.query("SELECT state, COUNT(*) AS n FROM direct_message_workflow_runs GROUP BY state"),
      unprocessedMessages: await count("SELECT COUNT(*) AS n FROM direct_message_workflow_messages WHERE processed_at IS NULL"),
    });

  const post = async (base: string, path: string, body: unknown) => {
    const res = await fetch(new URL(path, base), { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(202);
    return (await res.json()) as { results: { accepted: boolean }[] };
  };

  /** Drive the whole plan through `http`, waiting for the workers after each phase. */
  async function runPlan(http: Instance) {
    const base = await http.url();
    for (let i = 0; i < users.length; i += 500) {
      const body = users.slice(i, i + 500).map((u) => ({ instagramAccountId: u.account, commenterUserId: u.user, commentId: u.commentId, text: "Pricing please!" }));
      const { results } = await post(base, "/triggers/comments", { comments: body });
      expect(results.every((r) => r.accepted)).toBe(true);
    }
    // Phase 1: every commenter gets the DM and every comment a reply; every DM run then waits.
    await waitFor(
      async () =>
        (await count("SELECT COUNT(*) AS n FROM comment_workflow_runs WHERE state = $1", ["completed"])) === CONVERSATIONS &&
        (await count("SELECT COUNT(*) AS n FROM direct_message_workflow_runs WHERE state = $1", ["awaiting_email"])) === CONVERSATIONS,
      progress,
    );

    for (let i = 0; i < users.length; i += 500) {
      const body = users.slice(i, i + 500).map((u) => ({ instagramAccountId: u.account, fromUserId: u.user, text: u.reply }));
      const { results } = await post(base, "/triggers/messages", { messages: body });
      expect(results.every((r) => r.accepted)).toBe(true);
    }
    // Phase 2: valid emails are confirmed; invalid replies are re-prompted and the run waits again.
    await waitFor(
      async () =>
        (await count("SELECT COUNT(*) AS n FROM direct_message_workflow_runs WHERE state = $1", ["completed"])) === CONVERSATIONS / 2 &&
        (await count("SELECT COUNT(*) AS n FROM direct_message_workflow_messages WHERE processed_at IS NULL")) === 0 &&
        (await count("SELECT COUNT(*) AS n FROM direct_message_workflow_runs WHERE locked_by IS NOT NULL")) === 0,
      progress,
    );
  }

  test(`${WORKERS} worker instances share ${CONVERSATIONS} conversations, each Instagram call made exactly once`, async () => {
    const http = start("http", ["--no-worker", "--port", "0"]);
    const workers = Array.from({ length: WORKERS }, (_, i) => start(`worker-${i}`, workerArgs()));

    const started = performance.now();
    await runPlan(http);
    const seconds = (performance.now() - started) / 1000;

    const calls = workers.flatMap((w) => w.calls()).map(key).sort();
    expect(calls.length).toBe(expectedCalls.length);
    expect(calls).toEqual(expectedCalls); // nothing missing, nothing sent twice

    // The work really was spread over the instances.
    const perWorker = workers.map((w) => w.calls().length);
    expect(perWorker.every((n) => n > 0)).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM comment_workflow_runs WHERE locked_by IS NOT NULL OR attempts > 0")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM direct_message_workflow_runs WHERE attempts > 0")).toBe(0);

    console.log(
      `[load:${target.name}] ${CONVERSATIONS} conversations, ${calls.length} Instagram calls in ${seconds.toFixed(1)}s ` +
        `(${(calls.length / seconds).toFixed(0)} calls/s) across ${WORKERS} instances: ${perWorker.join(" / ")}`,
    );
  });

  test("instances with different roles each do only their part of the work", async () => {
    const http = start("http", ["--no-worker", "--port", "0"]);
    const commentWorkers = [start("comments-0", workerArgs("@comments")), start("comments-1", workerArgs("@comments"))];
    const dmWorkers = [start("dms-0", workerArgs("@direct-messages")), start("dms-1", workerArgs("@direct-messages"))];

    await runPlan(http);

    const commentCalls = commentWorkers.flatMap((w) => w.calls());
    const dmCalls = dmWorkers.flatMap((w) => w.calls());
    // Comment workers: the DM asking for the email and the comment reply, nothing else.
    expect(new Set(commentCalls.map((c) => c.text))).toEqual(new Set([TEXTS.askEmail, TEXTS.commentReply]));
    // DM workers: only confirmations and re-prompts.
    expect(dmCalls.every((c) => c.text !== TEXTS.askEmail && c.text !== TEXTS.commentReply)).toBe(true);
    expect([...commentCalls, ...dmCalls].map(key).sort()).toEqual(expectedCalls);
    for (const w of [...commentWorkers, ...dmWorkers]) expect(w.calls().length).toBeGreaterThan(0);
  });
});
