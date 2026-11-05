import type { DryRunCall } from "../src/instagram/client";

/** A processor process started for a load test, with its stdout collected line by line. */
export interface Instance {
  name: string;
  /** Instagram calls this instance made (the dry-run client prints one JSON line per call). */
  calls(): DryRunCall[];
  output(): string;
  /** Resolves with the HTTP URL once the instance logs it (HTTP instances only). */
  url(): Promise<string>;
  stop(): Promise<void>;
}

export function startInstance(name: string, databaseUrl: string, args: string[]): Instance {
  const proc = Bun.spawn(["bun", "run", "src/processor/cli.ts", ...args], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines: string[] = [];
  let stderr = "";
  const pump = async (stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        onLine(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    }
    if (buffer) onLine(buffer);
  };
  const reading = Promise.all([pump(proc.stdout, (l) => lines.push(l)), pump(proc.stderr, (l) => (stderr += `${l}\n`))]);

  return {
    name,
    calls: () => lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as DryRunCall),
    output: () => `${lines.join("\n")}\n${stderr}`,
    async url() {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        for (const l of lines) {
          const match = l.match(/listening on (\S+)/);
          if (match) return match[1]!;
        }
        if (proc.exitCode !== null) break;
        await Bun.sleep(20);
      }
      throw new Error(`${name} did not report its URL:\n${lines.join("\n")}\n${stderr}`);
    },
    async stop() {
      proc.kill("SIGTERM");
      await proc.exited;
      await reading;
    },
  };
}

/** Poll `check` until it returns true, or fail after `timeoutMs` with `describe()`'s state. */
export async function waitFor(check: () => Promise<boolean>, describe: () => Promise<string>, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out after ${timeoutMs}ms. State: ${await describe()}`);
}
