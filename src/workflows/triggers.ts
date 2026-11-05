import type { Driver } from "../db";
import { COMMENT_WORKFLOWS, DIRECT_MESSAGE_WORKFLOWS } from "./index";
import { handleComment, handleComments, type CommentResult, type CommentTrigger } from "./kinds/comment";
import { handleMessage, handleMessages, type MessageResult, type MessageTrigger } from "./kinds/direct-message";

export type { CommentResult, CommentTrigger, MessageResult, MessageTrigger };

/** A comment on one of our posts: starts runs in the account's enabled comment workflows. */
export const onComment = (db: Driver, t: CommentTrigger, now = Date.now()): Promise<CommentResult> =>
  handleComment(db, COMMENT_WORKFLOWS, t, now);

/** A batch of comments (e.g. one webhook delivery): one result per comment, in order. */
export const onComments = (db: Driver, t: readonly CommentTrigger[], now = Date.now()): Promise<CommentResult[]> =>
  handleComments(db, COMMENT_WORKFLOWS, t, now);

/** A DM to one of our accounts: queued on the latest listening direct message run. */
export const onMessage = (db: Driver, t: MessageTrigger, now = Date.now()): Promise<MessageResult> =>
  handleMessage(db, DIRECT_MESSAGE_WORKFLOWS, t, now);

/** A batch of DMs (e.g. one webhook delivery): one result per message, in order. */
export const onMessages = (db: Driver, t: readonly MessageTrigger[], now = Date.now()): Promise<MessageResult[]> =>
  handleMessages(db, DIRECT_MESSAGE_WORKFLOWS, t, now);
