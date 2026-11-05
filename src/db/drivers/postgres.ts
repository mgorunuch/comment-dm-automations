import { SQL } from "bun";
import type { Driver, DriverFactory, Queryable } from "../types";

class PostgresDriver implements Driver {
  readonly dialect = "postgres" as const;
  constructor(private readonly sql: SQL) {}

  async ping() {
    await this.sql`SELECT 1`;
  }

  async schemaVersion() {
    await this.ensureVersionTable(this.sql);
    const rows = await this.sql`SELECT COALESCE(MAX(version), 0)::int AS v FROM schema_migrations`;
    return rows[0]?.v ?? 0;
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return [...(await this.sql.unsafe(sql, params as unknown[]))] as T[];
  }

  async transaction<R>(fn: (tx: Queryable) => Promise<R>): Promise<R> {
    return (await this.sql.begin(async (tx) =>
      fn({
        dialect: this.dialect,
        query: async <T,>(s: string, p: readonly unknown[] = []) => [...(await tx.unsafe(s, p as unknown[]))] as T[],
      }),
    )) as R;
  }

  async applyMigration(sql: string, version: number) {
    await this.sql.begin(async (tx) => {
      await this.ensureVersionTable(tx);
      await tx.unsafe(sql);
      await tx`INSERT INTO schema_migrations (version) VALUES (${version})`;
    });
  }

  async close() {
    await this.sql.close();
  }

  private async ensureVersionTable(sql: SQL) {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  }
}

export const postgresFactory: DriverFactory = {
  schemes: ["postgres", "postgresql"],
  async connect(url) {
    const sql = new SQL(url);
    await sql`SELECT 1`;
    return new PostgresDriver(sql);
  },
};
