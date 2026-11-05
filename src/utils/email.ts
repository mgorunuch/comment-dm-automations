/**
 * Validation of a user's reply to "send us your email".
 *
 * A reply is accepted when it contains exactly one email-like token and that token is a
 * valid address; surrounding text ("sure, it's a@b.co thanks") is allowed. Tokens starting
 * with "@" are treated as Instagram mentions, not emails.
 */
export type InvalidReason = "no_email" | "invalid_email" | "multiple_emails";

export type EmailValidation = { ok: true; email: string } | { ok: false; reason: InvalidReason };

const LOCAL_CHARS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const TLD = /^[A-Za-z]{2,63}$/;

/** Validate a single address (pragmatic subset of RFC 5321/5322). Returns it lowercased, or undefined. */
export function validateEmail(candidate: string): string | undefined {
  if (candidate.length > 254) return undefined;
  const parts = candidate.split("@");
  if (parts.length !== 2) return undefined;
  const [local, domain] = parts as [string, string];
  if (local.length < 1 || local.length > 64 || !LOCAL_CHARS.test(local)) return undefined;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return undefined;
  const labels = domain.split(".");
  if (labels.length < 2) return undefined;
  if (!labels.every((l) => l.length <= 63 && LABEL.test(l))) return undefined;
  if (!TLD.test(labels.at(-1)!)) return undefined;
  return candidate.toLowerCase();
}

/** Punctuation that commonly wraps an address in chat: <a@b.co>, "a@b.co", a@b.co. */
const WRAPPING = /^[<("'[{]+|[>)"'\]},;:.!?]+$/g;

export function parseEmailReply(text: string): EmailValidation {
  const candidates = new Set(
    text
      .split(/\s+/)
      .map((t) => t.replace(WRAPPING, ""))
      .filter((t) => t.includes("@") && !t.startsWith("@"))
      .map((t) => t.toLowerCase()),
  );
  if (candidates.size === 0) return { ok: false, reason: "no_email" };
  if (candidates.size > 1) return { ok: false, reason: "multiple_emails" };
  const email = validateEmail([...candidates][0]!);
  return email ? { ok: true, email } : { ok: false, reason: "invalid_email" };
}
