import type { HandlerGroups } from "./core/selection";

/**
 * Named roles for worker instances. Start a machine with `--handle @<group>` (or
 * WORKER_HANDLE=@<group>) to run only those handlers. Groups list selectors, see selectHandlers:
 * `workflow`, `workflow:state`, `*:state`, other `@groups`, or `!` exclusions.
 */
export const HANDLER_GROUPS: HandlerGroups = {
  /** Reacting to comments: DM the commenter, reply to the comment. */
  comments: ["receive_dm_comment"],
  /** Conversations in DMs: validate replies, re-prompt, confirm. */
  "direct-messages": ["direct_message_after_comment"],
  /** Only validating incoming replies (awaiting_email). */
  "reply-validation": ["direct_message_after_comment:awaiting_email"],
  /** Only sending confirmations once an email was received. */
  confirmations: ["direct_message_after_comment:email_received"],
};
