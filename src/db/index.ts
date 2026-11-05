import { MIGRATIONS } from "./migrations";
import { factoryFor } from "./registry";
import type { Driver, Migration } from "./types";

export type { Dialect, Driver, DriverFactory, Migration, Queryable } from "./types";
export { jsonParam, parseJson } from "./json";
export { registerDriver } from "./registry";
export { MIGRATIONS } from "./migrations";

export const DEFAULT_DATABASE_URL = "sqlite:data/app.db";
export const SCHEMA_VERSION = MIGRATIONS.length;

export function databaseUrl(override?: string): string {
  return override ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

/**
 * Connect, creating storage if needed, and apply pending migrations. Idempotent, so the
 * processor runs it on every start.
 */
export async function migrateDatabase(url: string, migrations: readonly Migration[] = MIGRATIONS): Promise<Driver> {
  const driver = await factoryFor(url).connect(url);
  try {
    for (let v = await driver.schemaVersion(); v < migrations.length; v++) {
      const m = migrations[v]!;
      const sql = typeof m.up === "string" ? m.up : m.up[driver.dialect];
      await driver.applyMigration(sql, v + 1);
    }
    return driver;
  } catch (err) {
    await driver.close();
    throw err;
  }
}
