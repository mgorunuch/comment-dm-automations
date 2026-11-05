import type { InvalidReason } from "../utils/email";

/** Sent in the final DM once a valid email is received. */
export const PRICING_LINK = "https://example.com/pricing";

/** Outbound message texts. */
export const TEXTS = {
  askEmail: "Hi! Reply to this message with your email address.",
  commentReply: "Sent you a DM!",
  confirm: (email: string) => `Thanks! We got your email (${email}). Here is the link: ${PRICING_LINK}`,
  /** Re-prompt after an invalid reply, by reason. */
  retry: {
    no_email: "We couldn't find an email address in your message. Please reply with your email address.",
    invalid_email: "That email address doesn't look right. Please check it and send it again.",
    multiple_emails: "Please send just one email address.",
  } satisfies Record<InvalidReason, string>,
};
