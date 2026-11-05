import { afterEach, beforeEach } from "bun:test";
import { migrateDatabase, type Driver } from "../src/db";
import { seed } from "./fixtures";
import type { Target } from "./targets";

/** Migrate and seed a fresh database for every test in the enclosing describe. */
export function useSeededDatabase(target: Target) {
  const ctx = {} as { url: string; db: Driver; cleanup: () => Promise<void> };
  beforeEach(async () => {
    const fresh = await target.fresh();
    ctx.url = fresh.url;
    ctx.cleanup = fresh.cleanup;
    ctx.db = await migrateDatabase(fresh.url);
    await seed(ctx.db);
  });
  afterEach(async () => {
    await ctx.db.close().catch(() => {});
    await ctx.cleanup();
  });
  return ctx;
}
