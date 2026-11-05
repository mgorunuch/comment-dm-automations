import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A database backend the contract suite runs against.
 * `fresh()` returns the URL of an empty, never-spawned database.
 */
export interface Target {
  name: string;
  fresh(): Promise<{ url: string; cleanup(): Promise<void> }>;
}

const sqlite: Target = {
  name: "sqlite",
  async fresh() {
    const dir = mkdtempSync(join(tmpdir(), "test-task-"));
    return { url: `sqlite:${join(dir, "app.db")}`, cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
  },
};

/** Opt-in: set TEST_POSTGRES_URL to a disposable database. Its public schema is wiped per test. */
function postgres(url: string): Target {
  const reset = async () => {
    const sql = new SQL(url);
    await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await sql.close();
  };
  return {
    name: "postgres",
    async fresh() {
      await reset();
      return { url, cleanup: reset };
    },
  };
}

export const TARGETS: Target[] = [
  sqlite,
  ...(process.env.TEST_POSTGRES_URL ? [postgres(process.env.TEST_POSTGRES_URL)] : []),
];
