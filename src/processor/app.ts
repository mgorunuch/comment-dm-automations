import type { Driver } from "../db";
import { onComment, onComments, onMessage, onMessages, type CommentTrigger, type MessageTrigger } from "../workflows/triggers";

/** Largest batch POST /triggers/comments accepts in one request. */
export const MAX_COMMENT_BATCH = 1000;

/** Largest batch POST /triggers/messages accepts in one request. */
export const MAX_MESSAGE_BATCH = 1000;

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function parseComment(v: unknown): CommentTrigger | undefined {
  if (!v || typeof v !== "object") return undefined;
  const b = v as Record<string, unknown>;
  if (!str(b.instagramAccountId) || !str(b.commenterUserId) || !str(b.commentId) || typeof b.text !== "string") return undefined;
  return { instagramAccountId: b.instagramAccountId, commenterUserId: b.commenterUserId, commentId: b.commentId, text: b.text };
}

const COMMENT_FIELDS = "instagramAccountId, commenterUserId, commentId and text are required";

function parseMessage(v: unknown): MessageTrigger | undefined {
  if (!v || typeof v !== "object") return undefined;
  const b = v as Record<string, unknown>;
  if (!str(b.instagramAccountId) || !str(b.fromUserId) || typeof b.text !== "string") return undefined;
  return { instagramAccountId: b.instagramAccountId, fromUserId: b.fromUserId, text: b.text };
}

const MESSAGE_FIELDS = "instagramAccountId, fromUserId and text are required";

/** Build the HTTP handler. Kept separate from the CLI so tests can call it directly. */
export function createApp(db: Driver) {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const route = `${req.method} ${url.pathname}`;

      if (route === "GET /health") {
        try {
          await db.ping();
          return Response.json({ status: "ok", dialect: db.dialect, schemaVersion: await db.schemaVersion() });
        } catch (err) {
          return Response.json({ status: "error", error: String(err) }, { status: 503 });
        }
      }

      if (route === "POST /triggers/comment") {
        const comment = parseComment(await readJson(req));
        if (!comment) return Response.json({ error: COMMENT_FIELDS }, { status: 400 });
        return Response.json(await onComment(db, comment), { status: 202 });
      }

      if (route === "POST /triggers/comments") {
        const b = await readJson(req);
        if (!b || !Array.isArray(b.comments)) {
          return Response.json({ error: "comments must be an array" }, { status: 400 });
        }
        if (b.comments.length > MAX_COMMENT_BATCH) {
          return Response.json({ error: `at most ${MAX_COMMENT_BATCH} comments per batch` }, { status: 413 });
        }
        const comments: CommentTrigger[] = [];
        for (const [index, raw] of b.comments.entries()) {
          const comment = parseComment(raw);
          if (!comment) return Response.json({ error: `comments[${index}]: ${COMMENT_FIELDS}` }, { status: 400 });
          comments.push(comment);
        }
        return Response.json({ results: await onComments(db, comments) }, { status: 202 });
      }

      if (route === "POST /triggers/message") {
        const message = parseMessage(await readJson(req));
        if (!message) return Response.json({ error: MESSAGE_FIELDS }, { status: 400 });
        return Response.json(await onMessage(db, message), { status: 202 });
      }

      if (route === "POST /triggers/messages") {
        const b = await readJson(req);
        if (!b || !Array.isArray(b.messages)) {
          return Response.json({ error: "messages must be an array" }, { status: 400 });
        }
        if (b.messages.length > MAX_MESSAGE_BATCH) {
          return Response.json({ error: `at most ${MAX_MESSAGE_BATCH} messages per batch` }, { status: 413 });
        }
        const messages: MessageTrigger[] = [];
        for (const [index, raw] of b.messages.entries()) {
          const message = parseMessage(raw);
          if (!message) return Response.json({ error: `messages[${index}]: ${MESSAGE_FIELDS}` }, { status: 400 });
          messages.push(message);
        }
        return Response.json({ results: await onMessages(db, messages) }, { status: 202 });
      }

      return Response.json({ error: "Not Found" }, { status: 404 });
    },
  };
}
