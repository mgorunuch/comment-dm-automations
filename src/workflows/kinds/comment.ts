import type { Driver, Queryable } from "../../db";
import { selectIn } from "../../utils/sql";
import { enabledLookup } from "../core/enabled";
import { insertRuns, type StateHandler, type WorkflowDefinition } from "../core/engine";

/**
 * Comment workflow kind. Every comment workflow stores its runs in comment_workflow_runs,
 * keyed by the commenter and the comment, and is started by the comment trigger.
 *
 * Per workflow, a comment is deduplicated (same comment_id) and a commenter is engaged at most
 * once per account, so nobody is messaged twice by the same workflow.
 */
export const COMMENT_KIND = "comment";
export const COMMENT_RUNS_TABLE = "comment_workflow_runs";

export interface CommentWorkflow extends WorkflowDefinition {
  kind: typeof COMMENT_KIND;
  /** State a new run starts in when a comment arrives. */
  initialState: string;
  /** Whether a comment starts this workflow (e.g. it contains a keyword). Default: every comment. */
  matches: (commentText: string) => boolean;
}

export function defineCommentWorkflow(spec: {
  name: string;
  initialState: string;
  /** Which comments start the workflow. Default: every comment. */
  matches?: (commentText: string) => boolean;
  handlers: Readonly<Record<string, StateHandler>>;
}): CommentWorkflow {
  return {
    kind: COMMENT_KIND,
    name: spec.name,
    table: COMMENT_RUNS_TABLE,
    columns: ["commenter_user_id", "comment_id"],
    initialState: spec.initialState,
    matches: spec.matches ?? (() => true),
    handlers: spec.handlers,
  };
}

export interface CommentTrigger {
  /** Our account's Instagram ID (the post owner). */
  instagramAccountId: string;
  commenterUserId: string;
  commentId: string;
  /** The comment's text, used to decide which workflows it starts. */
  text: string;
}

export type SkipReason = "duplicate_comment" | "commenter_already_engaged";

export type CommentResult =
  | {
      accepted: true;
      runs: { workflow: string; runId: string }[];
      skipped: { workflow: string; reason: SkipReason }[];
    }
  | { accepted: false; reason: "unknown_account" | "workflow_disabled" | "no_matching_workflow" | SkipReason };

/** Start runs for one comment. Same as a batch of one. */
export async function handleComment(
  db: Driver,
  workflows: readonly CommentWorkflow[],
  t: CommentTrigger,
  now = Date.now(),
): Promise<CommentResult> {
  return (await handleComments(db, workflows, [t], now))[0]!;
}

/**
 * Start runs for a batch of comments, in one transaction. For every comment, a run starts in
 * each comment workflow that is enabled for its account and matches the comment's text. Returns one result per comment, in input
 * order: accepted when at least one run started, otherwise the reason nothing did. Within a
 * batch, later entries see earlier ones, so a repeated comment or a second comment by the same
 * commenter is skipped exactly as if it had arrived in a later request.
 */
export async function handleComments(
  db: Driver,
  workflows: readonly CommentWorkflow[],
  triggers: readonly CommentTrigger[],
  now = Date.now(),
): Promise<CommentResult[]> {
  if (triggers.length === 0) return [];
  return db.transaction(async (tx) => {
    const accountIds = triggers.map((t) => t.instagramAccountId);
    const known = new Set(
      (
        await selectIn<{ instagram_id: string }>(
          tx,
          (list) => `SELECT instagram_id FROM instagram_accounts WHERE instagram_id IN (${list})`,
          [],
          accountIds,
        )
      ).map((r) => r.instagram_id),
    );
    const isEnabled = await enabledLookup(tx, accountIds);

    const runs = triggers.map(() => [] as { workflow: string; runId: string }[]);
    const skipped = triggers.map(() => [] as { workflow: string; reason: SkipReason }[]);

    for (const wf of workflows) {
      const targets = triggers
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => known.has(t.instagramAccountId) && isEnabled(t.instagramAccountId, wf.name) && wf.matches(t.text));
      if (targets.length === 0) continue;

      const ids = await insertRuns(
        tx,
        wf,
        targets.map(({ t }) => ({
          instagramAccountId: t.instagramAccountId,
          columns: { commenter_user_id: t.commenterUserId, comment_id: t.commentId },
          state: wf.initialState,
        })),
        now,
      );

      const notInserted = targets.filter((_, k) => ids[k] === undefined);
      const stored = new Set(
        (
          await selectIn<{ comment_id: string }>(
            tx,
            (list) => `SELECT comment_id FROM ${COMMENT_RUNS_TABLE} WHERE workflow = $1 AND comment_id IN (${list})`,
            [wf.name],
            notInserted.map(({ t }) => t.commentId),
          )
        ).map((r) => r.comment_id),
      );

      targets.forEach(({ t, i }, k) => {
        const runId = ids[k];
        if (runId) runs[i]!.push({ workflow: wf.name, runId });
        else skipped[i]!.push({ workflow: wf.name, reason: stored.has(t.commentId) ? "duplicate_comment" : "commenter_already_engaged" });
      });
    }

    return triggers.map((t, i): CommentResult => {
      if (!known.has(t.instagramAccountId)) return { accepted: false, reason: "unknown_account" };
      if (runs[i]!.length > 0) return { accepted: true, runs: runs[i]!, skipped: skipped[i]! };
      if (skipped[i]!.length > 0) return { accepted: false, reason: skipped[i]![0]!.reason };
      const enabledHere = workflows.some((wf) => isEnabled(t.instagramAccountId, wf.name));
      return { accepted: false, reason: enabledHere ? "no_matching_workflow" : "workflow_disabled" };
    });
  });
}
