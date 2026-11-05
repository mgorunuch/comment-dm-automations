/**
 * Outbound Instagram actions. `account` is our account's Instagram ID,
 * `recipient` is the Meta user ID of the person we talk to.
 */
export interface InstagramClient {
  sendDm(account: string, recipient: string, text: string): Promise<void>;
  replyToComment(account: string, commentId: string, text: string): Promise<void>;
}

/** One line a dry-run client writes per call. */
export type DryRunCall =
  | { instagram: "dm"; account: string; recipient: string; text: string }
  | { instagram: "reply"; account: string; commentId: string; text: string };

/**
 * Dry-run client: writes each call as one JSON line instead of calling Instagram. `latencyMs`
 * simulates a slow API. Replace with a Graph API client for real use.
 */
export function createDryRunInstagramClient(opts: { latencyMs?: number; write?: (line: string) => void } = {}): InstagramClient {
  const write = opts.write ?? ((line: string) => console.log(line));
  const call = async (entry: DryRunCall) => {
    if (opts.latencyMs) await Bun.sleep(opts.latencyMs);
    write(JSON.stringify(entry));
  };
  return {
    sendDm: (account, recipient, text) => call({ instagram: "dm", account, recipient, text }),
    replyToComment: (account, commentId, text) => call({ instagram: "reply", account, commentId, text }),
  };
}

export const loggingInstagramClient: InstagramClient = createDryRunInstagramClient();
