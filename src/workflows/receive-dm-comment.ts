import type { Driver } from "../db";
import { getRun } from "./core/engine";
import { startDirectMessageAfterComment } from "./direct-message-after-comment";
import { defineCommentWorkflow } from "./kinds/comment";
import { containsKeyword } from "../utils/keywords";
import { TEXTS } from "./texts";

/**
 * Receive-DM comment workflow (kind: comment): when a comment contains one of KEYWORDS, the
 * commenter receives a DM asking for their email. Other comments start nothing.
 *
 *   comment trigger              -> comment_received
 *   worker: DM asking for email  -> dm_sent     (+ startDirectMessageAfterComment)
 *   worker: reply to the comment -> completed
 */
export const RECEIVE_DM_COMMENT = "receive_dm_comment";

/** Comments containing one of these words (case-insensitive, whole word) start the workflow. */
export const KEYWORDS: readonly string[] = ["pricing"];

export const ReceiveDmCommentState = {
  Received: "comment_received",
  DmSent: "dm_sent",
  Completed: "completed",
} as const;

export const receiveDmCommentWorkflow = defineCommentWorkflow({
  name: RECEIVE_DM_COMMENT,
  initialState: ReceiveDmCommentState.Received,
  matches: (text) => containsKeyword(text, KEYWORDS),
  handlers: {
    [ReceiveDmCommentState.Received]: async (run, ctx) => {
      const instagramAccountId = run.instagram_account_id;
      const dmUserId = String(run.commenter_user_id);
      await ctx.instagram.sendDm(instagramAccountId, dmUserId, TEXTS.askEmail);
      startDirectMessageAfterComment(ctx, {
        instagramAccountId,
        dmUserId,
        origin: { workflow: RECEIVE_DM_COMMENT, runId: run.id },
      });
      return { state: ReceiveDmCommentState.DmSent };
    },
    [ReceiveDmCommentState.DmSent]: async (run, { instagram }) => {
      await instagram.replyToComment(run.instagram_account_id, String(run.comment_id), TEXTS.commentReply);
      return { state: ReceiveDmCommentState.Completed };
    },
  },
});

export const getReceiveDmCommentRun = (db: Driver, id: string) => getRun(db, receiveDmCommentWorkflow, id);
