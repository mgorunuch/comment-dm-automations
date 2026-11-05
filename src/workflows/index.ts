import { receiveDmCommentWorkflow } from "./receive-dm-comment";
import { directMessageAfterCommentWorkflow } from "./direct-message-after-comment";
import type { WorkflowDefinition } from "./core/engine";
import type { CommentWorkflow } from "./kinds/comment";
import type { DirectMessageWorkflow } from "./kinds/direct-message";

/** Comment workflows: each enabled one starts a run on every comment. */
export const COMMENT_WORKFLOWS: readonly CommentWorkflow[] = [receiveDmCommentWorkflow];

/** Direct message workflows: an incoming message goes to the latest listening run among them. */
export const DIRECT_MESSAGE_WORKFLOWS: readonly DirectMessageWorkflow[] = [directMessageAfterCommentWorkflow];

/** All workflows the worker drives. */
export const WORKFLOWS: readonly WorkflowDefinition[] = [...COMMENT_WORKFLOWS, ...DIRECT_MESSAGE_WORKFLOWS];
