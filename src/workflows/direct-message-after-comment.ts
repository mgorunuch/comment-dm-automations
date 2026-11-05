import type { Driver } from "../db";
import { parseEmailReply, type InvalidReason } from "../utils/email";
import { getRun, type HandlerContext, type HandlerResult, type Run, type WorkflowContext } from "./core/engine";
import { defineDirectMessageWorkflow, startDirectMessageWorkflow, takeMessages } from "./kinds/direct-message";
import { TEXTS } from "./texts";

/**
 * Direct message workflow (kind: direct_message) that collects the user's email. Started with
 * startDirectMessageAfterComment, e.g. by the receive_dm_comment workflow once its DM is sent.
 *
 *   startDirectMessageAfterComment                -> awaiting_email   (metadata.origin)
 *   message trigger                               stores the message; the run stays in awaiting_email
 *   worker (awaiting_email, has messages):
 *     valid email                                 -> email_received   (metadata.email)
 *     invalid, attempts left: re-prompt DM        -> awaiting_email   (metadata.invalidReplies, lastInvalidReason)
 *     invalid, MAX_INVALID_REPLIES reached        -> invalid_email    (final, no further DMs)
 *   worker: confirmation DM                       -> completed         (final)
 */
export const DIRECT_MESSAGE_AFTER_COMMENT = "direct_message_after_comment";

export const DirectMessageAfterCommentState = {
  AwaitingEmail: "awaiting_email",
  EmailReceived: "email_received",
  /** Final: the email was confirmed. */
  Completed: "completed",
  /** Final: MAX_INVALID_REPLIES replies without a valid email. */
  InvalidEmail: "invalid_email",
} as const;

/** The invalid reply that reaches this count ends the run in invalid_email instead of re-prompting. */
export const MAX_INVALID_REPLIES = 3;

/**
 * awaiting_email, once messages have arrived: validate them. The first valid email wins.
 * Otherwise they count as one invalid reply (with the reason of the last message): the user is
 * re-prompted and the run keeps waiting, or, on the last allowed attempt, the run ends in
 * invalid_email without another DM.
 */
async function handleAwaitingEmail(run: Run, ctx: HandlerContext): Promise<HandlerResult> {
  const messages = await takeMessages(run, ctx);
  const metadata = run.metadata;
  const results = messages.map(parseEmailReply);
  const valid = results.find((r) => r.ok);
  if (valid?.ok) return { state: DirectMessageAfterCommentState.EmailReceived, metadata: { ...metadata, email: valid.email } };

  const last = results.at(-1);
  const lastInvalidReason: InvalidReason = last && !last.ok ? last.reason : "no_email";
  const invalidReplies = Number(metadata.invalidReplies ?? 0) + 1;
  const next = { ...metadata, invalidReplies, lastInvalidReason };
  if (invalidReplies >= MAX_INVALID_REPLIES) return { state: DirectMessageAfterCommentState.InvalidEmail, metadata: next };

  await ctx.instagram.sendDm(run.instagram_account_id, String(run.dm_user_id), TEXTS.retry[lastInvalidReason]);
  return { state: DirectMessageAfterCommentState.AwaitingEmail, metadata: next };
}

export const directMessageAfterCommentWorkflow = defineDirectMessageWorkflow({
  name: DIRECT_MESSAGE_AFTER_COMMENT,
  listeningStates: [DirectMessageAfterCommentState.AwaitingEmail],
  handlers: {
    [DirectMessageAfterCommentState.AwaitingEmail]: handleAwaitingEmail,
    [DirectMessageAfterCommentState.EmailReceived]: async (run, { instagram }) => {
      await instagram.sendDm(run.instagram_account_id, String(run.dm_user_id), TEXTS.confirm(String(run.metadata.email)));
      return { state: DirectMessageAfterCommentState.Completed };
    },
  },
});

export const getDirectMessageAfterCommentRun = (db: Driver, id: string) => getRun(db, directMessageAfterCommentWorkflow, id);

/** Where a run was started from, kept in its metadata for tracing. */
export interface RunOrigin {
  workflow: string;
  runId: string;
}

/**
 * Start a direct_message_after_comment conversation with `dmUserId`: it waits for their email.
 * The run is created when `ctx` commits.
 */
export function startDirectMessageAfterComment(
  ctx: WorkflowContext,
  input: { instagramAccountId: string; dmUserId: string; origin: RunOrigin },
): void {
  startDirectMessageWorkflow(ctx, directMessageAfterCommentWorkflow, {
    instagramAccountId: input.instagramAccountId,
    dmUserId: input.dmUserId,
    state: DirectMessageAfterCommentState.AwaitingEmail,
    metadata: { origin: input.origin },
  });
}
