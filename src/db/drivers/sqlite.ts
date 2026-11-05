import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Driver, DriverFactory, Queryable } from "../types";

/** Accepts `sqlite:path`, `sqlite://path`, and `sqlite::memory:`. */
function pathFromUrl(url: string): string {
  return url.replace(/^sqlite:(\/\/)?/, "");
}

class SqliteDriver implements Driver {
  readonly dialect = "sqlite" as const;
  constructor(private readonly db: Database) {}

  async ping() {
    this.db.query("SELECT 1").get();
  }

  async schemaVersion() {
    return this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  }

  /**
   * bun:sqlite is one synchronous connection, so a transaction spanning awaits would
   * swallow statements from unrelated callers. While one is open, every other
   * statement and transaction waits for it to finish.
   */
  private openTx: Promise<void> | undefined;

  private exec<T>(sql: string, params: readonly unknown[]): T[] {
    // bun:sqlite understands ?1, ?2, ... so translate the portable $N placeholders.
    return this.db.query(sql.replace(/\$(\d+)/g, "?$1")).all(...(params as never[])) as T[];
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    while (this.openTx) await this.openTx;
    // No await between the check above and exec: nothing can open a transaction in between.
    return this.exec<T>(sql, params);
  }

  async transaction<R>(fn: (tx: Queryable) => Promise<R>): Promise<R> {
    while (this.openTx) await this.openTx;
    let release!: () => void;
    this.openTx = new Promise((r) => (release = r));
    try {
      this.db.run("BEGIN IMMEDIATE");
      const out = await fn({ dialect: this.dialect, query: async <T,>(s: string, p: readonly unknown[] = []) => this.exec<T>(s, p) });
      this.db.run("COMMIT");
      return out;
    } catch (err) {
      if (this.db.inTransaction) this.db.run("ROLLBACK");
      throw err;
    } finally {
      this.openTx = undefined;
      release();
    }
  }

  async applyMigration(sql: string, version: number) {
    this.db.transaction(() => {
      this.db.run(sql);
      this.db.run(`PRAGMA user_version = ${Math.trunc(version)}`);
    })();
  }

  async close() {
    this.db.close();
  }
}

export const sqliteFactory: DriverFactory = {
  schemes: ["sqlite"],
  async connect(url) {
    const path = pathFromUrl(url);
    const memory = path === ":memory:";
    if (!memory) {
      mkdirSync(dirname(path), { recursive: true });
    }
    const db = new Database(path, { create: true, readwrite: true, strict: true });
    if (!memory) db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA busy_timeout = 5000");
    return new SqliteDriver(db);
  },
};
