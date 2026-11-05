import { beforeEach, describe, expect, test } from "bun:test";
import type { InstagramClient } from "../src/instagram/client";
import { MAX_COMMENT_BATCH, MAX_MESSAGE_BATCH, createApp } from "../src/processor/app";
import { RECEIVE_DM_COMMENT, ReceiveDmCommentState, receiveDmCommentWorkflow, getReceiveDmCommentRun } from "../src/workflows/receive-dm-comment";
import {
  DIRECT_MESSAGE_AFTER_COMMENT,
  DirectMessageAfterCommentState,
  MAX_INVALID_REPLIES,
  directMessageAfterCommentWorkflow,
  getDirectMessageAfterCommentRun,
  startDirectMessageAfterComment,
} from "../src/workflows/direct-message-after-comment";
import { parseEmailReply } from "../src/utils/email";
import { disableWorkflow, enableWorkflow, enabledWorkflows, isWorkflowEnabled } from "../src/workflows/core/enabled";
import {
  FAILED,
  findRuns,
  getRun,
  insertRun,
  insertRuns,
  withWorkflowContext,
  type Run,
  type StateHandler,
} from "../src/workflows/core/engine";
import { PRICING_LINK, TEXTS } from "../src/workflows/texts";
import { defineCommentWorkflow, handleComment, handleComments } from "../src/workflows/kinds/comment";
import { defineDirectMessageWorkflow, handleMessage, takeMessages } from "../src/workflows/kinds/direct-message";
import { onComment, onComments, onMessage, onMessages } from "../src/workflows/triggers";
import { selectHandlers } from "../src/workflows/core/selection";
import { HANDLER_GROUPS } from "../src/workflows/groups";
import { WORKFLOWS } from "../src/workflows/index";
import { createWorker } from "../src/workflows/core/worker";
import { INSTAGRAM_ACCOUNTS } from "./fixtures";
import { useSeededDatabase } from "./setup";
import { TARGETS } from "./targets";

type Call =
  | { kind: "dm"; account: string; to: string; text: string }
  | { kind: "reply"; account: string; commentId: string; text: string };

/** Records outbound calls; `fail(n)` makes the next n calls throw. */
function fakeInstagram() {
  const calls: Call[] = [];
  let failNext = 0;
  const maybeFail = () => {
    if (failNext > 0) {
      failNext--;
      throw new Error("instagram unavailable");
    }
  };
  const client: InstagramClient = {
    async sendDm(account, to, text) {
      maybeFail();
      calls.push({ kind: "dm", account, to, text });
    },
    async replyToComment(account, commentId, text) {
      maybeFail();
      calls.push({ kind: "reply", account, commentId, text });
    },
  };
  return { client, calls, fail: (n: number) => void (failNext = n) };
}

const ACCOUNT = INSTAGRAM_ACCOUNTS.acmeOnly.instagram_id;
const OTHER_ACCOUNT = INSTAGRAM_ACCOUNTS.globexOnly.instagram_id;
const USER = "meta-user-1";
const OTHER_USER = "meta-user-2";
/** A comment that starts receive_dm_comment (contains the "pricing" keyword). */
const PRICING_COMMENT = "What's the pricing?";

describe.each(TARGETS)("$name", (target) => {
  const ctx = useSeededDatabase(target);
  let ig: ReturnType<typeof fakeInstagram>;
  let clock: number;
  const now = () => clock;
  const worker = (id = "worker-a", extra: Partial<Parameters<typeof createWorker>[0]> = {}) =>
    createWorker({ db: ctx.db, instagram: ig.client, workerId: id, now, ...extra });

  const comment = (commentId = "c1", commenterUserId = USER, instagramAccountId: string = ACCOUNT, text = PRICING_COMMENT) =>
    onComment(ctx.db, { instagramAccountId, commenterUserId, commentId, text }, clock);
  const message = (text: string, fromUserId = USER, instagramAccountId: string = ACCOUNT) =>
    onMessage(ctx.db, { instagramAccountId, fromUserId, text }, clock);
  const commentRun = async (id: string) => (await getReceiveDmCommentRun(ctx.db, id)) as Run;
  const dmRun = async (id: string) => (await getDirectMessageAfterCommentRun(ctx.db, id)) as Run;
  const dmRunsOf = (user = USER, account: string = ACCOUNT) =>
    findRuns(ctx.db, directMessageAfterCommentWorkflow, { instagramAccountId: account, columns: { dm_user_id: user } });
  /** Texts of a direct message run's unprocessed messages, oldest first. */
  const pending = async (runId: string) =>
    (
      await ctx.db.query<{ text: string }>(
        "SELECT text FROM direct_message_workflow_messages WHERE run_id = $1 AND processed_at IS NULL ORDER BY id",
        [runId],
      )
    ).map((r) => r.text);
  const startRun = async (commentId = "c1", user = USER) => {
    const r = await comment(commentId, user);
    if (!r.accepted) throw new Error(r.reason);
    return r.runs[0]!.runId;
  };

  beforeEach(() => {
    ig = fakeInstagram();
    clock = 1_000_000;
  });

  describe("comment trigger", () => {
    test("only comments containing the \"pricing\" keyword start the workflow", async () => {
      expect(await comment("c1", USER, ACCOUNT, "nice photo")).toEqual({ accepted: false, reason: "no_matching_workflow" });
      expect(await comment("c2", USER, ACCOUNT, "PRICING?")).toMatchObject({ accepted: true });
    });

    test("a comment without the keyword does not use up the commenter: their later \"pricing\" comment still starts it", async () => {
      await comment("c1", USER, ACCOUNT, "first!");
      expect(await comment("c2", USER, ACCOUNT, "and the pricing?")).toMatchObject({ accepted: true });
    });

    test("creates a comment run in comment_received, keyed by commenter and comment", async () => {
      const id = await startRun();
      expect(await commentRun(id)).toMatchObject({
        instagram_account_id: ACCOUNT,
        commenter_user_id: USER,
        comment_id: "c1",
        state: ReceiveDmCommentState.Received,
        metadata: {},
      });
    });

    test("a redelivered comment is ignored", async () => {
      await startRun();
      expect(await comment("c1")).toEqual({ accepted: false, reason: "duplicate_comment" });
    });

    test("a second comment by the same user on the same account is ignored, so nothing is resent", async () => {
      await startRun("c1");
      expect(await comment("c2")).toEqual({ accepted: false, reason: "commenter_already_engaged" });
    });

    test("the same user commenting on another of our accounts starts a separate run", async () => {
      await startRun("c1");
      expect(await comment("c2", USER, OTHER_ACCOUNT)).toMatchObject({ accepted: true });
    });

    test("a comment on an unknown account is ignored", async () => {
      expect(await comment("c1", USER, "not-our-account")).toEqual({ accepted: false, reason: "unknown_account" });
    });
  });

  describe("happy path", () => {
    test("comment run sends the DM and hands over to a direct message run that collects the email", async () => {
      const id = await startRun();
      const w = worker();

      // Comment run: DM asking for the email, which starts the direct message run.
      expect(await w.tick()).toMatchObject({ status: "advanced", workflow: RECEIVE_DM_COMMENT, from: ReceiveDmCommentState.Received });
      expect((await commentRun(id)).state).toBe(ReceiveDmCommentState.DmSent);
      const [dm] = await dmRunsOf();
      expect(dm).toMatchObject({
        instagram_account_id: ACCOUNT,
        dm_user_id: USER,
        state: DirectMessageAfterCommentState.AwaitingEmail,
        metadata: { origin: { workflow: RECEIVE_DM_COMMENT, runId: id } },
      });

      // Comment run: reply to the comment, then it is done.
      expect(await w.tick()).toMatchObject({ status: "advanced", workflow: RECEIVE_DM_COMMENT, from: ReceiveDmCommentState.DmSent });
      expect((await commentRun(id)).state).toBe(ReceiveDmCommentState.Completed);
      expect(await w.tick()).toEqual({ status: "idle" });

      // Direct message run: the trigger only stores the message; the run keeps waiting.
      expect(await message("sure, it's John.Doe@Example.com")).toEqual({ accepted: true, workflow: DIRECT_MESSAGE_AFTER_COMMENT, runId: dm!.id });
      expect((await dmRun(dm!.id)).state).toBe(DirectMessageAfterCommentState.AwaitingEmail);
      expect(await pending(dm!.id)).toEqual(["sure, it's John.Doe@Example.com"]);

      // The awaiting_email handler validates it.
      expect(await w.tick()).toMatchObject({ status: "advanced", from: DirectMessageAfterCommentState.AwaitingEmail });
      const validated = await dmRun(dm!.id);
      expect(validated).toMatchObject({
        state: DirectMessageAfterCommentState.EmailReceived,
        metadata: { email: "john.doe@example.com", origin: { workflow: RECEIVE_DM_COMMENT, runId: id } },
      });
      expect(await pending(dm!.id)).toEqual([]);

      expect(await w.tick()).toMatchObject({ status: "advanced", from: DirectMessageAfterCommentState.EmailReceived });
      expect((await dmRun(dm!.id)).state).toBe(DirectMessageAfterCommentState.Completed);
      expect(await w.tick()).toEqual({ status: "idle" });

      expect(ig.calls).toEqual([
        { kind: "dm", account: ACCOUNT, to: USER, text: TEXTS.askEmail },
        { kind: "reply", account: ACCOUNT, commentId: "c1", text: TEXTS.commentReply },
        { kind: "dm", account: ACCOUNT, to: USER, text: TEXTS.confirm("john.doe@example.com") },
      ]);
      // The final DM contains the link.
      expect(ig.calls.at(-1)!.text).toContain(PRICING_LINK);
    });

    test("an email arriving before the comment reply is accepted; both runs still finish", async () => {
      const id = await startRun();
      const w = worker();
      await w.tick(); // DM sent, direct message run started
      expect(await message("early@mail.com")).toMatchObject({ accepted: true });
      await w.drain();
      expect((await commentRun(id)).state).toBe(ReceiveDmCommentState.Completed);
      expect((await dmRunsOf())[0]).toMatchObject({ state: DirectMessageAfterCommentState.Completed, metadata: { email: "early@mail.com" } });
      expect(ig.calls.map((c) => c.kind).sort()).toEqual(["dm", "dm", "reply"]);
    });
  });

  describe("message trigger", () => {
    /** Start a run and drive it until its DM run is waiting for an email. */
    const waitingDmRun = async () => {
      await startRun();
      await worker().drain();
      ig.calls.length = 0;
      return (await dmRunsOf())[0]!.id;
    };

    test("does not parse or change the run: any text is stored for the run, which keeps waiting", async () => {
      const id = await waitingDmRun();
      expect(await message("no email here")).toEqual({ accepted: true, workflow: DIRECT_MESSAGE_AFTER_COMMENT, runId: id });
      expect((await dmRun(id)).state).toBe(DirectMessageAfterCommentState.AwaitingEmail);
      expect(await pending(id)).toEqual(["no email here"]);
      expect(await dmRun(id)).not.toHaveProperty("metadata.invalidReplies");
    });

    test("messages arriving before the handler runs are stored in order, not lost", async () => {
      const id = await waitingDmRun();
      await message("one sec");
      await message("me@mail.com");
      expect(await pending(id)).toEqual(["one sec", "me@mail.com"]);
    });

    test("a message before the DM was sent finds nothing waiting", async () => {
      await startRun();
      expect(await message("too@early.com")).toEqual({ accepted: false, reason: "no_waiting_run" });
    });

    test("only runs of the same account and the same user are affected", async () => {
      await waitingDmRun();
      expect(await message("x@y.io", OTHER_USER)).toEqual({ accepted: false, reason: "no_waiting_run" });
      expect(await message("x@y.io", USER, OTHER_ACCOUNT)).toEqual({ accepted: false, reason: "no_waiting_run" });
      expect((await dmRunsOf())[0]!.state).toBe(DirectMessageAfterCommentState.AwaitingEmail);
    });

    test("with overlapping runs for one user, only the latest listening run receives the message", async () => {
      const older = await waitingDmRun();
      clock += 1;
      const newer = (await insertRun(
        ctx.db,
        directMessageAfterCommentWorkflow,
        { instagramAccountId: ACCOUNT, columns: { dm_user_id: USER }, state: DirectMessageAfterCommentState.AwaitingEmail },
        clock,
      ))!;
      expect(await message("me@mail.com")).toEqual({ accepted: true, workflow: DIRECT_MESSAGE_AFTER_COMMENT, runId: newer });
      expect(await pending(older)).toEqual([]);
      expect(await pending(newer)).toEqual(["me@mail.com"]);
    });

    test("a newer run that is no longer listening is skipped in favour of the latest listening one", async () => {
      const listening = await waitingDmRun();
      clock += 1;
      await insertRun(
        ctx.db,
        directMessageAfterCommentWorkflow,
        { instagramAccountId: ACCOUNT, columns: { dm_user_id: USER }, state: DirectMessageAfterCommentState.Completed },
        clock,
      );
      expect(await message("me@mail.com")).toEqual({ accepted: true, workflow: DIRECT_MESSAGE_AFTER_COMMENT, runId: listening });
    });

    test("runs of another direct message workflow in the same table are not touched", async () => {
      const own = await waitingDmRun();
      const otherWorkflow = { ...directMessageAfterCommentWorkflow, name: "direct_message_other", handlers: {} };
      clock += 1;
      const foreign = (await insertRun(
        ctx.db,
        otherWorkflow,
        { instagramAccountId: ACCOUNT, columns: { dm_user_id: USER }, state: DirectMessageAfterCommentState.AwaitingEmail },
        clock,
      ))!;
      expect(await message("me@mail.com")).toEqual({ accepted: true, workflow: DIRECT_MESSAGE_AFTER_COMMENT, runId: own });
      expect(await getRun(ctx.db, otherWorkflow, foreign)).toMatchObject({
        workflow: "direct_message_other",
        state: DirectMessageAfterCommentState.AwaitingEmail,
      });
      expect(await getRun(ctx.db, directMessageAfterCommentWorkflow, foreign)).toBeUndefined();
    });
  });

  describe("awaiting_email handler (validation)", () => {
    const waitingDmRun = async () => {
      await startRun();
      await worker().drain();
      ig.calls.length = 0;
      return (await dmRunsOf())[0]!.id;
    };

    test("a waiting run without new messages is not picked up by the worker", async () => {
      await waitingDmRun();
      expect(await worker().tick()).toEqual({ status: "idle" });
    });

    test.each([
      ["what do you need?", "no_email"],
      ["   ", "no_email"],
      ["john@gmail", "invalid_email"],
      ["john..doe@gmail.com", "invalid_email"],
      ["a@b.com or c@d.com", "multiple_emails"],
    ] as const)("%p is rejected as %p: the user is asked again and the run keeps waiting", async (text, reason) => {
      const id = await waitingDmRun();
      await message(text);

      expect(await worker().tick()).toMatchObject({ status: "advanced", from: DirectMessageAfterCommentState.AwaitingEmail });
      expect(await dmRun(id)).toMatchObject({
        state: DirectMessageAfterCommentState.AwaitingEmail,
        metadata: { invalidReplies: 1, lastInvalidReason: reason },
      });
      expect(ig.calls).toEqual([{ kind: "dm", account: ACCOUNT, to: USER, text: TEXTS.retry[reason] }]);
      expect(await pending(id)).toEqual([]);
      expect(await worker().tick()).toEqual({ status: "idle" });
    });

    test("a valid email after an invalid reply completes the run", async () => {
      const id = await waitingDmRun();
      await message("hmm");
      await worker().drain();
      await message("ok: me@mail.com");
      await worker().drain();
      expect(await dmRun(id)).toMatchObject({
        state: DirectMessageAfterCommentState.Completed,
        metadata: { email: "me@mail.com", invalidReplies: 1 },
      });
      expect(ig.calls.map((c) => c.text)).toEqual([TEXTS.retry.no_email, TEXTS.confirm("me@mail.com")]);
    });

    test("among several waiting messages the first valid email wins, with no re-prompt", async () => {
      const id = await waitingDmRun();
      await message("hmm");
      await message("me@mail.com");
      await message("other@mail.com");
      await worker().tick();
      expect(await dmRun(id)).toMatchObject({ state: DirectMessageAfterCommentState.EmailReceived, metadata: { email: "me@mail.com" } });
      expect(await pending(id)).toEqual([]);
      await worker().drain();
      expect(ig.calls.map((c) => c.text)).toEqual([TEXTS.confirm("me@mail.com")]);
    });

    test("several waiting messages without a valid email count as one invalid reply, with the last one's reason", async () => {
      const id = await waitingDmRun();
      await message("john@gmail");
      await message("hello?");
      await worker().tick();
      expect(await dmRun(id)).toMatchObject({
        state: DirectMessageAfterCommentState.AwaitingEmail,
        metadata: { invalidReplies: 1, lastInvalidReason: "no_email" },
      });
      expect(ig.calls.map((c) => c.text)).toEqual([TEXTS.retry.no_email]);
    });

    test("a message that arrives while the handler runs is kept for the next round", async () => {
      const id = await waitingDmRun();
      await message("hmm");
      // The user answers while the re-prompt is being sent.
      const late: InstagramClient = {
        sendDm: async () => void (await message("late@mail.com")),
        replyToComment: async () => {},
      };
      await createWorker({ db: ctx.db, instagram: late, workerId: "w", now }).tick();
      expect(await dmRun(id)).toMatchObject({ state: DirectMessageAfterCommentState.AwaitingEmail, metadata: { invalidReplies: 1 } });
      expect(await pending(id)).toEqual(["late@mail.com"]);

      await worker().drain();
      expect(await dmRun(id)).toMatchObject({ state: DirectMessageAfterCommentState.Completed, metadata: { email: "late@mail.com" } });
    });

    test("messages stay unprocessed if the handler fails, and are handled on retry", async () => {
      const id = await waitingDmRun();
      await message("hmm");
      ig.fail(1);
      expect(await worker("w", { retryDelayMs: 0 }).tick()).toMatchObject({ status: "failed" });
      expect(await pending(id)).toEqual(["hmm"]);
      expect(await worker().tick()).toMatchObject({ status: "advanced" });
      expect(await pending(id)).toEqual([]);
      expect(ig.calls.map((c) => c.text)).toEqual([TEXTS.retry.no_email]);
    });

    test(`the run ends in the final invalid_email state after ${MAX_INVALID_REPLIES} invalid replies, without another DM`, async () => {
      const id = await waitingDmRun();
      for (let i = 1; i <= MAX_INVALID_REPLIES; i++) {
        await message(`attempt ${i}`);
        await worker().drain();
      }
      expect(await dmRun(id)).toMatchObject({
        state: DirectMessageAfterCommentState.InvalidEmail,
        metadata: { invalidReplies: MAX_INVALID_REPLIES },
      });
      expect(ig.calls).toHaveLength(MAX_INVALID_REPLIES - 1);
      expect(await message("me@mail.com")).toEqual({ accepted: false, reason: "no_waiting_run" });
    });
  });

  describe("storage", () => {
    test("state is plain indexed text and metadata is JSON", async () => {
      await startRun();
      await worker().tick();
      const rows = await ctx.db.query<{ state: string }>(
        `SELECT state FROM ${directMessageAfterCommentWorkflow.table} WHERE state = $1 AND metadata ->> 'origin' IS NOT NULL`,
        [DirectMessageAfterCommentState.AwaitingEmail],
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe("locking", () => {
    test("a leased run cannot be taken by another worker until the lease expires", async () => {
      const id = await startRun();
      const hung: InstagramClient = { sendDm: () => new Promise(() => {}), replyToComment: () => new Promise(() => {}) };
      void createWorker({ db: ctx.db, instagram: hung, workerId: "worker-a", now, leaseMs: 60_000 }).tick();
      await Bun.sleep(20);

      const b = worker("worker-b");
      expect(await b.tick()).toEqual({ status: "idle" });

      clock += 60_000;
      expect(await b.tick()).toMatchObject({ status: "advanced", runId: id });
      expect((await commentRun(id)).state).toBe(ReceiveDmCommentState.DmSent);
    });

    test("a worker that lost its lease changes nothing and starts no second direct message run", async () => {
      const id = await startRun();
      let releaseA!: () => void;
      const slow: InstagramClient = {
        sendDm: () => new Promise<void>((r) => (releaseA = r)),
        replyToComment: async () => {},
      };
      const a = createWorker({ db: ctx.db, instagram: slow, workerId: "worker-a", now, leaseMs: 60_000 }).tick();
      await Bun.sleep(20);

      clock += 60_000;
      expect(await worker("worker-b").tick()).toMatchObject({ status: "advanced", runId: id });

      releaseA();
      expect(await a).toMatchObject({ status: "lease_lost", runId: id });
      expect(await dmRunsOf()).toHaveLength(1);
    });

    test("concurrent workers process every run exactly once", async () => {
      for (let i = 0; i < 10; i++) await startRun(`c${i}`, `user-${i}`);
      const workers = ["w1", "w2", "w3", "w4"].map((id) => worker(id));
      await Promise.all(workers.map((w) => w.drain()));
      expect(ig.calls.filter((c) => c.kind === "dm")).toHaveLength(10);
      const replies = ig.calls.filter((c) => c.kind === "reply");
      expect(new Set(replies.map((c) => c.kind === "reply" && c.commentId)).size).toBe(10);
      expect(replies).toHaveLength(10);
      const dmRuns = await ctx.db.query(`SELECT id FROM ${directMessageAfterCommentWorkflow.table}`);
      expect(dmRuns).toHaveLength(10);
    });
  });

  describe("failures", () => {
    test("a failed handler keeps the state, records the error and retries after the delay", async () => {
      const id = await startRun();
      const w = worker("worker-a", { retryDelayMs: 30_000 });
      ig.fail(1);

      expect(await w.tick()).toMatchObject({ status: "failed", error: "instagram unavailable" });
      expect(await commentRun(id)).toMatchObject({ state: ReceiveDmCommentState.Received, attempts: 1, last_error: "instagram unavailable" });
      expect(await dmRunsOf()).toHaveLength(0);
      expect(await w.tick()).toEqual({ status: "idle" });

      clock += 30_000;
      expect(await w.tick()).toMatchObject({ status: "advanced" });
      expect(await commentRun(id)).toMatchObject({ state: ReceiveDmCommentState.DmSent, attempts: 0, last_error: null });
    });

    test("a handler that keeps failing ends in failed, remembering where", async () => {
      const id = await startRun();
      const w = worker("worker-a", { retryDelayMs: 0, maxAttempts: 3 });
      ig.fail(100);
      await w.drain();
      expect(await commentRun(id)).toMatchObject({ state: FAILED, attempts: 3, metadata: { failedState: ReceiveDmCommentState.Received } });
      expect(ig.calls).toEqual([]);
    });
  });

  describe("enabled workflows", () => {
    const SHARED = INSTAGRAM_ACCOUNTS.shared.instagram_id; // seeded with no workflows enabled

    test("the seed enables both workflows on acme and globex and none on shared", async () => {
      expect(await enabledWorkflows(ctx.db, ACCOUNT)).toEqual([DIRECT_MESSAGE_AFTER_COMMENT, RECEIVE_DM_COMMENT].sort());
      expect(await enabledWorkflows(ctx.db, OTHER_ACCOUNT)).toEqual([DIRECT_MESSAGE_AFTER_COMMENT, RECEIVE_DM_COMMENT].sort());
      expect(await enabledWorkflows(ctx.db, SHARED)).toEqual([]);
    });

    test("a comment on an account without the comment workflow starts nothing", async () => {
      expect(await comment("c1", USER, SHARED)).toEqual({ accepted: false, reason: "workflow_disabled" });
      await enableWorkflow(ctx.db, SHARED, RECEIVE_DM_COMMENT);
      expect(await comment("c1", USER, SHARED)).toMatchObject({ accepted: true });
    });

    test("enabling is idempotent and disabling removes it", async () => {
      await enableWorkflow(ctx.db, SHARED, RECEIVE_DM_COMMENT);
      await enableWorkflow(ctx.db, SHARED, RECEIVE_DM_COMMENT);
      expect(await isWorkflowEnabled(ctx.db, SHARED, RECEIVE_DM_COMMENT)).toBe(true);
      await disableWorkflow(ctx.db, SHARED, RECEIVE_DM_COMMENT);
      expect(await isWorkflowEnabled(ctx.db, SHARED, RECEIVE_DM_COMMENT)).toBe(false);
    });

    test("workflows are enabled per account: disabling on one account leaves the other running", async () => {
      await disableWorkflow(ctx.db, OTHER_ACCOUNT, RECEIVE_DM_COMMENT);
      expect(await comment("c2", USER, OTHER_ACCOUNT)).toEqual({ accepted: false, reason: "workflow_disabled" });
      expect(await comment("c1", USER, ACCOUNT)).toMatchObject({ accepted: true });
    });

    test("disabling a workflow pauses its in-flight runs, and enabling it resumes them", async () => {
      const id = await startRun();
      await disableWorkflow(ctx.db, ACCOUNT, RECEIVE_DM_COMMENT);
      expect(await worker().tick()).toEqual({ status: "idle" });
      expect((await commentRun(id)).state).toBe(ReceiveDmCommentState.Received);
      expect(ig.calls).toEqual([]);

      await enableWorkflow(ctx.db, ACCOUNT, RECEIVE_DM_COMMENT);
      expect(await worker().tick()).toMatchObject({ status: "advanced", runId: id });
      expect((await commentRun(id)).state).toBe(ReceiveDmCommentState.DmSent);
    });

    test("an email is ignored while the direct message workflow is disabled", async () => {
      await startRun();
      await worker().drain();
      const [dm] = await dmRunsOf();
      await disableWorkflow(ctx.db, ACCOUNT, DIRECT_MESSAGE_AFTER_COMMENT);

      expect(await message("me@mail.com")).toEqual({ accepted: false, reason: "workflow_disabled" });
      expect((await dmRun(dm!.id)).state).toBe(DirectMessageAfterCommentState.AwaitingEmail);

      await enableWorkflow(ctx.db, ACCOUNT, DIRECT_MESSAGE_AFTER_COMMENT);
      expect(await message("me@mail.com")).toMatchObject({ accepted: true });
    });

    test("a paused direct message run does not send its confirmation until re-enabled", async () => {
      await startRun();
      await worker().drain();
      await message("me@mail.com");
      await disableWorkflow(ctx.db, ACCOUNT, DIRECT_MESSAGE_AFTER_COMMENT);
      const sent = ig.calls.length;

      expect(await worker().tick()).toEqual({ status: "idle" });
      expect(ig.calls).toHaveLength(sent);

      await enableWorkflow(ctx.db, ACCOUNT, DIRECT_MESSAGE_AFTER_COMMENT);
      await worker().drain();
      expect((await dmRunsOf())[0]!.state).toBe(DirectMessageAfterCommentState.Completed);
    });

    test("deleting an instagram account removes its enabled workflows", async () => {
      await ctx.db.query("DELETE FROM instagram_accounts WHERE instagram_id = $1", [ACCOUNT]);
      expect(await enabledWorkflows(ctx.db, ACCOUNT)).toEqual([]);
    });
  });

  describe("workflow kinds", () => {
    // A second workflow of each kind, sharing the kind's table with the real one.
    const otherComment = defineCommentWorkflow({ name: "comment_other", initialState: "started", handlers: {} });
    const otherDm = defineDirectMessageWorkflow({
      name: "direct_message_other",
      listeningStates: ["waiting"],
      handlers: { waiting: async () => ({ state: "done" }) },
    });
    const COMMENTS = [receiveDmCommentWorkflow, otherComment];
    const DMS = [directMessageAfterCommentWorkflow, otherDm];
    const dmRunOf = (wf: typeof otherDm, state: string) =>
      insertRun(ctx.db, wf, { instagramAccountId: ACCOUNT, columns: { dm_user_id: USER }, state }, clock);

    test("a defined workflow gets its kind's table and key columns", () => {
      expect(otherComment).toMatchObject({ kind: "comment", table: "comment_workflow_runs", columns: ["commenter_user_id", "comment_id"] });
      expect(otherDm).toMatchObject({ kind: "direct_message", table: "direct_message_workflow_runs", columns: ["dm_user_id"] });
    });

    test("every listening state of a direct message workflow needs a handler", () => {
      expect(() => defineDirectMessageWorkflow({ name: "broken", listeningStates: ["waiting"], handlers: {} })).toThrow(
        "listening states without a handler: waiting",
      );
    });

    test("a comment starts a run in every enabled comment workflow", async () => {
      await enableWorkflow(ctx.db, ACCOUNT, otherComment.name);
      const res = await handleComment(ctx.db, COMMENTS, { instagramAccountId: ACCOUNT, commenterUserId: USER, commentId: "c1", text: PRICING_COMMENT }, clock);
      expect(res.accepted && res.runs.map((r) => r.workflow).sort()).toEqual([RECEIVE_DM_COMMENT, otherComment.name].sort());
      const other = res.accepted && res.runs.find((r) => r.workflow === otherComment.name)!;
      expect(await getRun(ctx.db, otherComment, (other as { runId: string }).runId)).toMatchObject({ state: "started" });
    });

    test("each comment workflow decides which comments start it", async () => {
      await enableWorkflow(ctx.db, ACCOUNT, otherComment.name); // otherComment matches every comment
      const res = await handleComment(ctx.db, COMMENTS, { instagramAccountId: ACCOUNT, commenterUserId: USER, commentId: "c1", text: "hello" }, clock);
      expect(res.accepted && res.runs.map((r) => r.workflow)).toEqual([otherComment.name]);
    });

    test("a comment skips comment workflows that are not enabled", async () => {
      const res = await handleComment(ctx.db, COMMENTS, { instagramAccountId: ACCOUNT, commenterUserId: USER, commentId: "c1", text: PRICING_COMMENT }, clock);
      expect(res.accepted && res.runs.map((r) => r.workflow)).toEqual([RECEIVE_DM_COMMENT]);
    });

    test("dedupe is per workflow: a comment already handled by one workflow can still start another", async () => {
      await startRun("c1");
      await enableWorkflow(ctx.db, ACCOUNT, otherComment.name);
      const res = await handleComment(ctx.db, COMMENTS, { instagramAccountId: ACCOUNT, commenterUserId: USER, commentId: "c1", text: PRICING_COMMENT }, clock);
      expect(res).toMatchObject({
        accepted: true,
        runs: [{ workflow: otherComment.name }],
        skipped: [{ workflow: RECEIVE_DM_COMMENT, reason: "duplicate_comment" }],
      });
    });

    test("a message goes to the latest listening run across all enabled direct message workflows", async () => {
      await enableWorkflow(ctx.db, ACCOUNT, otherDm.name);
      const older = (await insertRun(
        ctx.db,
        directMessageAfterCommentWorkflow,
        { instagramAccountId: ACCOUNT, columns: { dm_user_id: USER }, state: DirectMessageAfterCommentState.AwaitingEmail },
        clock,
      ))!;
      clock += 1;
      const newer = (await dmRunOf(otherDm, "waiting"))!;
      const res = await handleMessage(ctx.db, DMS, { instagramAccountId: ACCOUNT, fromUserId: USER, text: "hi" }, clock);
      expect(res).toEqual({ accepted: true, workflow: otherDm.name, runId: newer });
      expect(await getRun(ctx.db, otherDm, newer)).toMatchObject({ state: "waiting" });
      expect(await pending(newer)).toEqual(["hi"]);
      expect(await pending(older)).toEqual([]);
      expect((await dmRun(older)).state).toBe(DirectMessageAfterCommentState.AwaitingEmail);
    });

    test("each workflow's own listening states decide whether its run can receive", async () => {
      await enableWorkflow(ctx.db, ACCOUNT, otherDm.name);
      const listening = (await insertRun(
        ctx.db,
        directMessageAfterCommentWorkflow,
        { instagramAccountId: ACCOUNT, columns: { dm_user_id: USER }, state: DirectMessageAfterCommentState.AwaitingEmail },
        clock,
      ))!;
      clock += 1;
      // "awaiting_email" is not one of the other workflow's listening states.
      await dmRunOf(otherDm, DirectMessageAfterCommentState.AwaitingEmail);
      const res = await handleMessage(ctx.db, DMS, { instagramAccountId: ACCOUNT, fromUserId: USER, text: "hi" }, clock);
      expect(res).toEqual({ accepted: true, workflow: DIRECT_MESSAGE_AFTER_COMMENT, runId: listening });
    });

    test("runs of a disabled direct message workflow are not targeted, even when newer", async () => {
      const own = (await insertRun(
        ctx.db,
        directMessageAfterCommentWorkflow,
        { instagramAccountId: ACCOUNT, columns: { dm_user_id: USER }, state: DirectMessageAfterCommentState.AwaitingEmail },
        clock,
      ))!;
      clock += 1;
      await dmRunOf(otherDm, "waiting"); // otherDm is not enabled
      const res = await handleMessage(ctx.db, DMS, { instagramAccountId: ACCOUNT, fromUserId: USER, text: "hi" }, clock);
      expect(res).toEqual({ accepted: true, workflow: DIRECT_MESSAGE_AFTER_COMMENT, runId: own });
    });

    test("takeMessages returns unprocessed messages oldest first and marks them processed on commit", async () => {
      const runId = (await dmRunOf(otherDm, "waiting"))!;
      const run = (await getRun(ctx.db, otherDm, runId))!;
      await enableWorkflow(ctx.db, ACCOUNT, otherDm.name);
      await handleMessage(ctx.db, [otherDm], { instagramAccountId: ACCOUNT, fromUserId: USER, text: "a" }, clock);
      await handleMessage(ctx.db, [otherDm], { instagramAccountId: ACCOUNT, fromUserId: USER, text: "b" }, clock);

      const texts = await withWorkflowContext(ctx.db, async (wctx) => {
        const taken = await takeMessages(run, { ...wctx, db: ctx.db, instagram: ig.client });
        expect(await pending(runId)).toEqual(["a", "b"]); // not marked until commit
        return taken;
      });
      expect(texts).toEqual(["a", "b"]);
      expect(await pending(runId)).toEqual([]);
    });
  });

  describe("comment batches", () => {
    const SHARED = INSTAGRAM_ACCOUNTS.shared.instagram_id; // no workflows enabled
    const c = (commentId: string, commenterUserId = USER, instagramAccountId: string = ACCOUNT) => ({
      instagramAccountId,
      commenterUserId,
      commentId,
      text: PRICING_COMMENT,
    });
    const batch = (triggers: ReturnType<typeof c>[]) => onComments(ctx.db, triggers, clock);
    const countCommentRuns = async () =>
      Number((await ctx.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM comment_workflow_runs"))[0]!.n);

    test("an empty batch returns no results", async () => {
      expect(await batch([])).toEqual([]);
    });

    test("returns one result per comment, in input order, with every outcome", async () => {
      await startRun("old", "user-old"); // already stored before the batch
      const results = await batch([
        c("b1", "user-1"), //                   new
        c("b2", "user-2", OTHER_ACCOUNT), //    new, other account
        c("b3", "user-3", "not-our-account"), // unknown account
        c("b4", "user-4", SHARED), //           no workflow enabled
        c("old", "user-old"), //                 duplicate of a stored comment
        c("b1", "user-1"), //                   duplicate of an earlier entry in this batch
        c("b5", "user-1"), //                   same commenter again, earlier in this batch
        c("b6", "user-old"), //                  commenter engaged before the batch
      ]);
      expect(results.map((r) => (r.accepted ? "accepted" : r.reason))).toEqual([
        "accepted",
        "accepted",
        "unknown_account",
        "workflow_disabled",
        "duplicate_comment",
        "duplicate_comment",
        "commenter_already_engaged",
        "commenter_already_engaged",
      ]);
      const first = results[0]!;
      if (!first.accepted) throw new Error("first comment should start a run");
      expect(await commentRun(first.runs[0]!.runId)).toMatchObject({
        comment_id: "b1",
        commenter_user_id: "user-1",
        state: ReceiveDmCommentState.Received,
      });
    });

    test("a batch gives the same results as sending the comments one by one", async () => {
      const input = [c("x1", "u1"), c("x1", "u1"), c("x2", "u1"), c("x3", "u2"), c("x4", "u3", SHARED)];
      const batched: string[] = (await batch(input)).map((r) => (r.accepted ? "accepted" : r.reason));

      await ctx.db.query("DELETE FROM comment_workflow_runs");
      const single: string[] = [];
      for (const t of input) {
        const r = await onComment(ctx.db, t, clock);
        single.push(r.accepted ? "accepted" : r.reason);
      }
      expect(batched).toEqual(single);
    });

    test("large batches are inserted in chunks", async () => {
      const input = Array.from({ length: 1234 }, (_, i) => c(`big-${i}`, `user-${i}`));
      const results = await batch(input);
      expect(results.every((r) => r.accepted)).toBe(true);
      expect(await countCommentRuns()).toBe(1234);
    });

    test("runs from a batch are processed by the worker like any other", async () => {
      await batch([c("w1", "user-1"), c("w2", "user-2")]);
      await worker().drain();
      expect(ig.calls.filter((call) => call.kind === "reply").map((call) => call.kind === "reply" && call.commentId).sort()).toEqual([
        "w1",
        "w2",
      ]);
    });

    test("a batch is atomic: if it fails, none of its comments are stored", async () => {
      const exploding = defineCommentWorkflow({ name: "comment_exploding", initialState: "x", handlers: {} });
      // Missing key column makes insertRuns throw after the first workflow already inserted.
      const broken = { ...exploding, columns: [...exploding.columns, "no_such_column"] };
      await enableWorkflow(ctx.db, ACCOUNT, broken.name);
      await expect(handleComments(ctx.db, [receiveDmCommentWorkflow, broken], [c("atomic-1")], clock)).rejects.toThrow();
      expect(await countCommentRuns()).toBe(0);
    });

    describe("POST /triggers/comments", () => {
      const post = (body: unknown) =>
        createApp(ctx.db).fetch(
          new Request("http://test/triggers/comments", {
            method: "POST",
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
        );

      test("starts runs and returns results in order", async () => {
        const res = await post({ comments: [c("h1", "u1"), c("h2", "u1"), c("h3", "u3", SHARED)] });
        expect(res.status).toBe(202);
        const body = (await res.json()) as { results: { accepted: boolean; reason?: string }[] };
        expect(body.results.map((r) => (r.accepted ? "accepted" : r.reason))).toEqual([
          "accepted",
          "commenter_already_engaged",
          "workflow_disabled",
        ]);
      });

      test("rejects a malformed entry with its index, storing nothing", async () => {
        const res = await post({ comments: [c("ok"), { instagramAccountId: ACCOUNT, commentId: "bad" }] });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toStartWith("comments[1]:");
        expect(await countCommentRuns()).toBe(0);
      });

      test("rejects a body without a comments array", async () => {
        expect((await post({ comment: [] })).status).toBe(400);
      });

      test(`rejects batches larger than ${MAX_COMMENT_BATCH}`, async () => {
        const comments = Array.from({ length: MAX_COMMENT_BATCH + 1 }, (_, i) => c(`t${i}`, `u${i}`));
        expect((await post({ comments })).status).toBe(413);
      });
    });
  });

  describe("message batches", () => {
    const SHARED = INSTAGRAM_ACCOUNTS.shared.instagram_id; // no workflows enabled
    const m = (text: string, fromUserId = USER, instagramAccountId: string = ACCOUNT) => ({ instagramAccountId, fromUserId, text });
    const batch = (triggers: ReturnType<typeof m>[]) => onMessages(ctx.db, triggers, clock);
    /** Drive a comment from `user` until its direct message run waits for an email. */
    const waitingDmRunFor = async (user: string, account: string = ACCOUNT) => {
      const r = await comment(`c-${user}-${account}`, user, account);
      if (!r.accepted) throw new Error(r.reason);
      await worker().drain();
      return (await dmRunsOf(user, account))[0]!.id;
    };

    test("an empty batch returns no results", async () => {
      expect(await batch([])).toEqual([]);
    });

    test("returns one result per message, in input order, with every outcome", async () => {
      const a = await waitingDmRunFor("user-a");
      const b = await waitingDmRunFor("user-b", OTHER_ACCOUNT);
      const results = await batch([
        m("hi", "user-a"), //                  waiting run
        m("a@b.co", "user-b", OTHER_ACCOUNT), // waiting run on another account
        m("hello", "nobody"), //               no run for this user
        m("hey", "user-a", SHARED), //         no workflow enabled
        m("me@x.io", "user-a"), //             same conversation again
      ]);
      expect(results).toEqual([
        { accepted: true, workflow: DIRECT_MESSAGE_AFTER_COMMENT, runId: a },
        { accepted: true, workflow: DIRECT_MESSAGE_AFTER_COMMENT, runId: b },
        { accepted: false, reason: "no_waiting_run" },
        { accepted: false, reason: "workflow_disabled" },
        { accepted: true, workflow: DIRECT_MESSAGE_AFTER_COMMENT, runId: a },
      ]);
    });

    test("messages of one conversation are stored for its run in input order", async () => {
      const a = await waitingDmRunFor("user-a");
      await batch([m("one", "user-a"), m("x", "user-b"), m("two", "user-a"), m("three", "user-a")]);
      expect((await dmRun(a)).state).toBe(DirectMessageAfterCommentState.AwaitingEmail);
      expect(await pending(a)).toEqual(["one", "two", "three"]);
    });

    test("a batch gives the same run state as sending the messages one by one", async () => {
      const a = await waitingDmRunFor("user-a");
      const input = [m("hmm", "user-a"), m("me@mail.com", "user-a")];
      await batch(input);
      const batched = { state: (await dmRun(a)).state, pending: await pending(a) };

      const b = await waitingDmRunFor("user-b");
      for (const t of input) await onMessage(ctx.db, { ...t, fromUserId: "user-b" }, clock);
      const single = { state: (await dmRun(b)).state, pending: await pending(b) };

      expect(single).toEqual(batched);
    });

    test("a batch still goes to the latest listening run only", async () => {
      const older = await waitingDmRunFor("user-a");
      clock += 1;
      const newer = (await insertRun(
        ctx.db,
        directMessageAfterCommentWorkflow,
        { instagramAccountId: ACCOUNT, columns: { dm_user_id: "user-a" }, state: DirectMessageAfterCommentState.AwaitingEmail },
        clock,
      ))!;
      await batch([m("one", "user-a"), m("two", "user-a")]);
      expect(await pending(newer)).toEqual(["one", "two"]);
      expect(await pending(older)).toEqual([]);
    });

    test("large batches across many conversations are handled in chunks", async () => {
      const users = Array.from({ length: 300 }, (_, i) => `bulk-${i}`);
      const runs = await insertRuns(
        ctx.db,
        directMessageAfterCommentWorkflow,
        users.map((u) => ({ instagramAccountId: ACCOUNT, columns: { dm_user_id: u }, state: DirectMessageAfterCommentState.AwaitingEmail })),
        clock,
      );
      const results = await batch(users.flatMap((u) => [m("a", u), m("b", u)]));
      expect(results.every((r) => r.accepted)).toBe(true);
      expect(await pending(runs[299]!)).toEqual(["a", "b"]);
    });

    test("queued batches are validated by the worker like any other", async () => {
      const a = await waitingDmRunFor("user-a");
      ig.calls.length = 0;
      await batch([m("not yet", "user-a"), m("me@mail.com", "user-a")]);
      await worker().drain();
      expect(await dmRun(a)).toMatchObject({ state: DirectMessageAfterCommentState.Completed, metadata: { email: "me@mail.com" } });
      expect(ig.calls.map((c) => c.text)).toEqual([TEXTS.confirm("me@mail.com")]);
    });

    describe("POST /triggers/messages", () => {
      const post = (body: unknown) =>
        createApp(ctx.db).fetch(
          new Request("http://test/triggers/messages", {
            method: "POST",
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
        );

      test("queues messages and returns results in order", async () => {
        const a = await waitingDmRunFor("user-a");
        const res = await post({ messages: [m("hi", "user-a"), m("hi", "nobody")] });
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({
          results: [
            { accepted: true, workflow: DIRECT_MESSAGE_AFTER_COMMENT, runId: a },
            { accepted: false, reason: "no_waiting_run" },
          ],
        });
      });

      test("rejects a malformed entry with its index, queuing nothing", async () => {
        const a = await waitingDmRunFor("user-a");
        const res = await post({ messages: [m("hi", "user-a"), { instagramAccountId: ACCOUNT, text: "no sender" }] });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toStartWith("messages[1]:");
        expect((await dmRun(a)).state).toBe(DirectMessageAfterCommentState.AwaitingEmail);
      });

      test("rejects a body without a messages array", async () => {
        expect((await post({ message: [] })).status).toBe(400);
      });

      test(`rejects batches larger than ${MAX_MESSAGE_BATCH}`, async () => {
        const messages = Array.from({ length: MAX_MESSAGE_BATCH + 1 }, (_, i) => m("x", `u${i}`));
        expect((await post({ messages })).status).toBe(413);
      });
    });
  });

  describe("workflow context", () => {
    /** A comment workflow whose single handler is `handler`, enabled on ACCOUNT, with one run started. */
    const customRun = async (handler: StateHandler) => {
      const wf = defineCommentWorkflow({ name: "comment_custom", initialState: "start", handlers: { start: handler } });
      await enableWorkflow(ctx.db, ACCOUNT, wf.name);
      const res = await handleComment(ctx.db, [wf], { instagramAccountId: ACCOUNT, commenterUserId: USER, commentId: "cc", text: PRICING_COMMENT }, clock);
      if (!res.accepted) throw new Error(res.reason);
      const w = createWorker({ db: ctx.db, instagram: ig.client, workflows: [wf], workerId: "w", now });
      return { wf, runId: res.runs[0]!.runId, w };
    };

    test("startDirectMessageAfterComment can start a workflow manually through withWorkflowContext", async () => {
      await withWorkflowContext(
        ctx.db,
        async (wctx) => {
          startDirectMessageAfterComment(wctx, {
            instagramAccountId: ACCOUNT,
            dmUserId: USER,
            origin: { workflow: "manual", runId: "n/a" },
          });
          // Deferred: nothing is written until the context commits.
          expect(await dmRunsOf()).toEqual([]);
        },
        clock,
      );
      expect(await dmRunsOf()).toMatchObject([
        { state: DirectMessageAfterCommentState.AwaitingEmail, metadata: { origin: { workflow: "manual", runId: "n/a" } } },
      ]);
    });

    test("a handler result only changes its own run; other workflows start through the context", async () => {
      const id = await startRun();
      await worker().tick();
      expect((await commentRun(id)).state).toBe(ReceiveDmCommentState.DmSent);
      expect(await dmRunsOf()).toMatchObject([{ metadata: { origin: { workflow: RECEIVE_DM_COMMENT, runId: id } } }]);
    });

    test("writes deferred by a handler that then fails are dropped", async () => {
      const { runId, w } = await customRun(async (run, hctx) => {
        startDirectMessageAfterComment(hctx, { instagramAccountId: ACCOUNT, dmUserId: USER, origin: { workflow: "x", runId: run.id } });
        throw new Error("boom");
      });
      expect(await w.tick()).toMatchObject({ status: "failed", error: "boom", runId });
      expect(await dmRunsOf()).toEqual([]);
    });

    test("a failing deferred write rolls back the handler's state change, and the run is retried", async () => {
      const { wf, runId, w } = await customRun(async (_run, hctx) => {
        hctx.defer(async (tx) => {
          await tx.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [crypto.randomUUID(), "written-then-rolled-back"]);
          throw new Error("deferred write failed");
        });
        return { state: "done" };
      });
      expect(await w.tick()).toMatchObject({ status: "failed", error: "deferred write failed" });
      expect(await getRun(ctx.db, wf, runId)).toMatchObject({ state: "start", attempts: 1, last_error: "deferred write failed" });
      expect(await ctx.db.query("SELECT 1 FROM tenants WHERE name = $1", ["written-then-rolled-back"])).toEqual([]);
    });

    test("deferred writes run in order, in the same transaction as the new state", async () => {
      const order: string[] = [];
      const { wf, runId, w } = await customRun(async (_run, hctx) => {
        hctx.defer(async () => void order.push("first"));
        hctx.defer(async (tx) => {
          // The handler's own state change is already visible inside the transaction.
          const [row] = await tx.query<{ state: string }>("SELECT state FROM comment_workflow_runs WHERE workflow = $1", ["comment_custom"]);
          order.push(`second:${row!.state}`);
        });
        return { state: "done" };
      });
      expect(await w.tick()).toMatchObject({ status: "advanced" });
      expect(order).toEqual(["first", "second:done"]);
      expect((await getRun(ctx.db, wf, runId))!.state).toBe("done");
    });
  });

  describe("ignored events", () => {
    const SHARED = INSTAGRAM_ACCOUNTS.shared.instagram_id; // no workflows enabled

    /** Every run (both kinds) and every stored message, to prove an event changed nothing. */
    const snapshot = async () => ({
      comments: await ctx.db.query("SELECT id, workflow, state, metadata, version FROM comment_workflow_runs ORDER BY id"),
      dms: await ctx.db.query("SELECT id, workflow, state, metadata, version FROM direct_message_workflow_runs ORDER BY id"),
      messages: await ctx.db.query("SELECT id, run_id, text, processed_at FROM direct_message_workflow_messages ORDER BY id"),
    });
    /** Drive a comment by USER until its DM run waits for an email. */
    const waiting = async () => {
      await startRun();
      await worker().drain();
    };

    /** `setupSends`: calls the setup's own unfinished work makes when drained (never the ignored event's). */
    type Case = { name: string; setup?: () => Promise<unknown>; event: () => Promise<unknown>; reason: string; setupSends?: string[] };
    const SETUP_COMMENT_C1 = [`dm:${USER}:${TEXTS.askEmail}`, `reply:c1:${TEXTS.commentReply}`];
    const describeCall = (call: Call) => (call.kind === "dm" ? `dm:${call.to}:${call.text}` : `reply:${call.commentId}:${call.text}`);
    const cases: Case[] = [
      // Comments
      {
        name: "a comment without the \"pricing\" keyword",
        event: () => comment("c1", USER, ACCOUNT, "love this post!"),
        reason: "no_matching_workflow",
      },
      { name: "a comment on an account that is not ours", event: () => comment("c1", USER, "not-our-account"), reason: "unknown_account" },
      { name: "a comment on an account with no workflows enabled", event: () => comment("c1", USER, SHARED), reason: "workflow_disabled" },
      {
        name: "a comment while the comment workflow is disabled",
        setup: () => disableWorkflow(ctx.db, ACCOUNT, RECEIVE_DM_COMMENT),
        event: () => comment("c1"),
        reason: "workflow_disabled",
      },
      { name: "a redelivered comment (webhook retry)", setup: waiting, event: () => comment("c1"), reason: "duplicate_comment" },
      {
        name: "a second comment by a commenter we already messaged",
        setup: waiting,
        event: () => comment("c2"),
        reason: "commenter_already_engaged",
      },
      {
        name: "a second comment while the first one is still being handled",
        setup: () => startRun("c1"),
        event: () => comment("c2"),
        reason: "commenter_already_engaged",
        setupSends: SETUP_COMMENT_C1,
      },
      // Messages
      { name: "a DM from someone we never talked to", event: () => message("hi", "stranger"), reason: "no_waiting_run" },
      {
        name: "a DM before our DM was sent",
        setup: () => startRun(),
        event: () => message("a@b.co"),
        reason: "no_waiting_run",
        setupSends: SETUP_COMMENT_C1,
      },
      { name: "a DM from another user than the one we wait for", setup: waiting, event: () => message("a@b.co", OTHER_USER), reason: "no_waiting_run" },
      {
        name: "a DM to another of our accounts than the conversation's",
        setup: waiting,
        event: () => message("a@b.co", USER, OTHER_ACCOUNT),
        reason: "no_waiting_run",
      },
      {
        name: "a DM after the conversation completed",
        setup: async () => {
          await waiting();
          await message("a@b.co");
          await worker().drain();
        },
        event: () => message("again@b.co"),
        reason: "no_waiting_run",
      },
      {
        name: "a DM after the conversation ended in invalid_email",
        setup: async () => {
          await waiting();
          for (let i = 0; i < MAX_INVALID_REPLIES; i++) {
            await message("no email");
            await worker().drain();
          }
        },
        event: () => message("late@b.co"),
        reason: "no_waiting_run",
      },
      {
        name: "a DM while the direct message workflow is disabled",
        setup: async () => {
          await waiting();
          await disableWorkflow(ctx.db, ACCOUNT, DIRECT_MESSAGE_AFTER_COMMENT);
        },
        event: () => message("a@b.co"),
        reason: "workflow_disabled",
      },
      { name: "a DM to an account with no workflows enabled", event: () => message("a@b.co", USER, SHARED), reason: "workflow_disabled" },
      { name: "a DM to an account that is not ours", event: () => message("a@b.co", USER, "not-our-account"), reason: "workflow_disabled" },
    ];

    test.each(cases)("$name is ignored: nothing stored, nothing changed, nothing sent", async ({ setup, event, reason, setupSends }) => {
      await setup?.();
      const before = await snapshot();
      ig.calls.length = 0;

      expect(await event()).toEqual({ accepted: false, reason });

      expect(await snapshot()).toEqual(before);
      await worker().drain();
      expect(ig.calls.map(describeCall)).toEqual(setupSends ?? []);
    });

    test("ignored events inside a batch do not affect the accepted ones", async () => {
      await waiting();
      ig.calls.length = 0;
      const comments = await onComments(ctx.db, [c("c1"), { instagramAccountId: ACCOUNT, commenterUserId: "new-user", commentId: "fresh", text: PRICING_COMMENT }], clock);
      expect(comments.map((r) => (r.accepted ? "accepted" : r.reason))).toEqual(["duplicate_comment", "accepted"]);
      const messages = await onMessages(ctx.db, [{ instagramAccountId: ACCOUNT, fromUserId: "stranger", text: "hi" }, { instagramAccountId: ACCOUNT, fromUserId: USER, text: "me@mail.com" }], clock);
      expect(messages.map((r) => (r.accepted ? "accepted" : r.reason))).toEqual(["no_waiting_run", "accepted"]);
      await worker().drain();
      // Only the accepted events produced work: the new commenter's DM + reply, and USER's confirmation.
      expect(ig.calls.map((call) => (call.kind === "dm" ? `dm:${call.to}` : `reply:${call.commentId}`)).sort()).toEqual(
        ["dm:new-user", "dm:meta-user-1", "reply:fresh"].sort(),
      );
    });

    function c(commentId: string) {
      return { instagramAccountId: ACCOUNT, commenterUserId: USER, commentId, text: PRICING_COMMENT };
    }
  });

  describe("handler selection (worker roles)", () => {
    test("a worker only claims runs whose workflow:state it is configured to handle", async () => {
      await startRun();
      const dmOnly = worker("dm-only", { handles: selectHandlers("@direct-messages", WORKFLOWS, HANDLER_GROUPS) });
      expect(dmOnly.handles).toEqual([{ workflow: DIRECT_MESSAGE_AFTER_COMMENT, states: ["awaiting_email", "email_received"] }]);
      expect(await dmOnly.tick()).toEqual({ status: "idle" });
      expect(ig.calls).toEqual([]);
    });

    test("workers with different roles complete the whole flow together, each doing only its part", async () => {
      const commentsIg = fakeInstagram();
      const dmsIg = fakeInstagram();
      const comments = createWorker({ db: ctx.db, instagram: commentsIg.client, workerId: "comments", now, handles: selectHandlers("@comments", WORKFLOWS, HANDLER_GROUPS) });
      const dms = createWorker({ db: ctx.db, instagram: dmsIg.client, workerId: "dms", now, handles: selectHandlers("@direct-messages", WORKFLOWS, HANDLER_GROUPS) });

      const id = await startRun();
      expect(await dms.drain()).toBe(0);
      await comments.drain();
      expect((await commentRun(id)).state).toBe(ReceiveDmCommentState.Completed);

      await message("me@mail.com");
      expect(await comments.drain()).toBe(0);
      await dms.drain();
      expect((await dmRunsOf())[0]!.state).toBe(DirectMessageAfterCommentState.Completed);

      expect(commentsIg.calls.map((call) => call.text)).toEqual([TEXTS.askEmail, TEXTS.commentReply]);
      expect(dmsIg.calls.map((call) => call.text)).toEqual([TEXTS.confirm("me@mail.com")]);
    });

    test("a single state can be split off to its own worker", async () => {
      await startRun();
      await worker().drain();
      await message("me@mail.com");
      const validators = worker("validators", { handles: selectHandlers("@reply-validation", WORKFLOWS, HANDLER_GROUPS) });
      const confirmers = worker("confirmers", { handles: selectHandlers("@confirmations", WORKFLOWS, HANDLER_GROUPS) });
      ig.calls.length = 0;

      expect(await confirmers.tick()).toEqual({ status: "idle" });
      expect(await validators.tick()).toMatchObject({ status: "advanced", from: DirectMessageAfterCommentState.AwaitingEmail });
      expect(await validators.tick()).toEqual({ status: "idle" });
      expect(await confirmers.tick()).toMatchObject({ status: "advanced", from: DirectMessageAfterCommentState.EmailReceived });
      expect(ig.calls.map((call) => call.text)).toEqual([TEXTS.confirm("me@mail.com")]);
    });
  });

  describe("HTTP triggers", () => {
    const post = (path: string, body: unknown) =>
      createApp(ctx.db).fetch(
        new Request(`http://test${path}`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
      );

    test("POST /triggers/comment starts a comment run", async () => {
      const res = await post("/triggers/comment", { instagramAccountId: ACCOUNT, commenterUserId: USER, commentId: "c1", text: PRICING_COMMENT });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { accepted: true; runs: { runId: string }[] };
      expect((await commentRun(body.runs[0]!.runId)).state).toBe(ReceiveDmCommentState.Received);
    });

    test("POST /triggers/message stores the message for the waiting run", async () => {
      await startRun();
      await worker().drain();
      const res = await post("/triggers/message", { instagramAccountId: ACCOUNT, fromUserId: USER, text: "a@b.co" });
      expect(res.status).toBe(202);
      const [run] = await dmRunsOf();
      expect(run!.state).toBe(DirectMessageAfterCommentState.AwaitingEmail);
      expect(await pending(run!.id)).toEqual(["a@b.co"]);
    });

    test("malformed trigger payloads are rejected with 400", async () => {
      expect((await post("/triggers/comment", { commenterUserId: USER })).status).toBe(400);
      expect((await post("/triggers/comment", { instagramAccountId: ACCOUNT, commenterUserId: USER, commentId: "c1" })).status).toBe(400);
      expect((await post("/triggers/message", "nope")).status).toBe(400);
    });
  });
});

describe("parseEmailReply", () => {
  test.each([
    // accepted
    ["a@b.co", { ok: true, email: "a@b.co" }],
    ["my email is Foo.Bar+tag@Sub.Example.co.uk thanks", { ok: true, email: "foo.bar+tag@sub.example.co.uk" }],
    ["<me@mail.com>.", { ok: true, email: "me@mail.com" }],
    ["me@mail.com ME@MAIL.COM", { ok: true, email: "me@mail.com" }],
    ["@acme_official here: me@mail.com", { ok: true, email: "me@mail.com" }],
    // no email
    ["", { ok: false, reason: "no_email" }],
    ["no email here", { ok: false, reason: "no_email" }],
    ["thanks @acme_official", { ok: false, reason: "no_email" }],
    // malformed
    ["broken@address", { ok: false, reason: "invalid_email" }],
    ["john@", { ok: false, reason: "invalid_email" }],
    ["a@@b.com", { ok: false, reason: "invalid_email" }],
    [".john@mail.com", { ok: false, reason: "invalid_email" }],
    ["john.@mail.com", { ok: false, reason: "invalid_email" }],
    ["john@-mail.com", { ok: false, reason: "invalid_email" }],
    ["john@mail..com", { ok: false, reason: "invalid_email" }],
    ["john@mail.c", { ok: false, reason: "invalid_email" }],
    ["john@mail.123", { ok: false, reason: "invalid_email" }],
    [`${"a".repeat(65)}@mail.com`, { ok: false, reason: "invalid_email" }],
    // ambiguous
    ["a@b.com c@d.com", { ok: false, reason: "multiple_emails" }],
    ["a@b.com or broken@x", { ok: false, reason: "multiple_emails" }],
  ] as const)("%p -> %p", (text, expected) => {
    expect(parseEmailReply(text)).toEqual(expected);
  });
});
