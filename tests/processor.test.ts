import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS, SCHEMA_VERSION, migrateDatabase, type Driver } from "../src/db";
import { createApp } from "../src/processor/app";
import { INSTAGRAM_ACCOUNTS, TENANTS, seed } from "./fixtures";
import { TARGETS } from "./targets";

/** Read a process's stdout until it logs "listening on <url>", and return that URL. */
async function listeningUrl(stdout: ReadableStream<Uint8Array>, timeoutMs = 10_000): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
      const match = seen.match(/listening on (\S+)/);
      if (match) return match[1]!;
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`processor did not report its URL; output: ${seen}`);
}

/** The same contract runs against every database driver. */
describe.each(TARGETS)("$name", (target) => {
  let url: string;
  let cleanup: () => Promise<void>;
  let db: Driver;
  let app: ReturnType<typeof createApp>;

  const get = (path: string) => app.fetch(new Request(`http://test${path}`));

  beforeEach(async () => {
    ({ url, cleanup } = await target.fresh());
    db = await migrateDatabase(url);
    await seed(db);
    app = createApp(db);
  });

  afterEach(async () => {
    await db.close().catch(() => {});
    await cleanup();
  });

  describe("processor HTTP API", () => {
    test("GET /health reports ok, the dialect and the schema version", async () => {
      const res = await get("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok", dialect: target.name, schemaVersion: SCHEMA_VERSION });
    });

    test("GET /health returns 503 when the database is unusable", async () => {
      await db.close();
      const res = await get("/health");
      expect(res.status).toBe(503);
      expect(((await res.json()) as { status: string }).status).toBe("error");
    });

    test("unknown routes return 404", async () => {
      expect((await get("/nope")).status).toBe(404);
    });
  });

  describe("database lifecycle", () => {
    test("migrating a fresh database brings it to the latest schema version", async () => {
      const fresh = await target.fresh();
      try {
        const migrated = await migrateDatabase(fresh.url);
        expect(await migrated.schemaVersion()).toBe(SCHEMA_VERSION);
        await migrated.close();
      } finally {
        await fresh.cleanup();
      }
    });

    test("migrating applies only pending migrations and is idempotent", async () => {
      const newer = [...MIGRATIONS, { name: "extra", up: "CREATE TABLE extra (id INTEGER)" }];
      await (await migrateDatabase(url, newer)).close();
      const again = await migrateDatabase(url, newer);
      expect(await again.schemaVersion()).toBe(SCHEMA_VERSION + 1);
      await again.close();
    });
  });

  describe("tenants and instagram accounts schema", () => {
    const { acme, globex } = TENANTS;
    const { acmeOnly, globexOnly, shared } = INSTAGRAM_ACCOUNTS;

    /** Instagram IDs linked to a tenant, sorted. No join needed: the link stores the Instagram ID. */
    const accountsOf = async (tenantId: string) =>
      (
        await db.query<{ instagram_account_id: string }>(
          "SELECT instagram_account_id FROM tenant_instagram_accounts WHERE tenant_id = $1 ORDER BY instagram_account_id",
          [tenantId],
        )
      ).map((r) => r.instagram_account_id);
    /** Tenant names linked to an instagram account, sorted. */
    const tenantsOf = async (instagramId: string) =>
      (
        await db.query<{ name: string }>(
          `SELECT t.name FROM tenants t
           JOIN tenant_instagram_accounts l ON l.tenant_id = t.id
           WHERE l.instagram_account_id = $1 ORDER BY t.name`,
          [instagramId],
        )
      ).map((r) => r.name);
    const addAccount = (instagramId: string, username: string | null = "someone") =>
      db.query("INSERT INTO instagram_accounts (instagram_id, username) VALUES ($1, $2)", [instagramId, username]);
    const link = (tenantId: string, instagramId: string) =>
      db.query("INSERT INTO tenant_instagram_accounts (tenant_id, instagram_account_id) VALUES ($1, $2)", [
        tenantId,
        instagramId,
      ]);
    const count = async (table: string) =>
      Number((await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]!.n);

    test("starts pre-seeded with the fixture tenants, accounts and links", async () => {
      const tenants = await db.query<{ id: string; name: string }>("SELECT id, name FROM tenants ORDER BY name");
      expect(tenants.map((t) => ({ id: String(t.id), name: t.name }))).toEqual([acme, globex]);
      expect(await accountsOf(acme.id)).toEqual([acmeOnly.instagram_id, shared.instagram_id]);
      expect(await accountsOf(globex.id)).toEqual([globexOnly.instagram_id, shared.instagram_id]);
      const usernames = await db.query<{ username: string }>("SELECT username FROM instagram_accounts WHERE instagram_id = $1", [
        shared.instagram_id,
      ]);
      expect(usernames).toEqual([{ username: shared.username }]);
    });

    test("one instagram account can belong to many tenants without being duplicated", async () => {
      expect(await tenantsOf(shared.instagram_id)).toEqual([acme.name, globex.name]);
      expect(await count("instagram_accounts")).toBe(Object.keys(INSTAGRAM_ACCOUNTS).length);
    });

    test("the instagram ID identifies an account: it cannot be stored twice", async () => {
      await expect(addAccount(shared.instagram_id)).rejects.toThrow();
    });

    test("linking a tenant to an account it already has is rejected", async () => {
      await expect(link(acme.id, shared.instagram_id)).rejects.toThrow();
    });

    test("an existing account can be linked to another tenant", async () => {
      await link(globex.id, acmeOnly.instagram_id);
      expect(await tenantsOf(acmeOnly.instagram_id)).toEqual([acme.name, globex.name]);
    });

    test("links must reference an existing tenant and an existing account", async () => {
      await expect(link(crypto.randomUUID(), shared.instagram_id)).rejects.toThrow();
      await expect(link(acme.id, "17841499999999999")).rejects.toThrow();
    });

    test("an instagram account may exist without any tenant", async () => {
      await addAccount("17841400000000999");
      expect(await tenantsOf("17841400000000999")).toEqual([]);
    });

    test("deleting a tenant removes its links but keeps the instagram accounts", async () => {
      await db.query("DELETE FROM tenants WHERE id = $1", [acme.id]);
      expect(await accountsOf(acme.id)).toEqual([]);
      expect(await tenantsOf(shared.instagram_id)).toEqual([globex.name]);
      expect(await count("instagram_accounts")).toBe(Object.keys(INSTAGRAM_ACCOUNTS).length);
    });

    test("deleting an instagram account removes it from every tenant", async () => {
      await db.query("DELETE FROM instagram_accounts WHERE instagram_id = $1", [shared.instagram_id]);
      expect(await accountsOf(acme.id)).toEqual([acmeOnly.instagram_id]);
      expect(await accountsOf(globex.id)).toEqual([globexOnly.instagram_id]);
    });

    test("tenant name and instagram username are required", async () => {
      await expect(db.query("INSERT INTO tenants (id, name) VALUES ($1, NULL)", [crypto.randomUUID()])).rejects.toThrow();
      await expect(addAccount("17841400000000998", null)).rejects.toThrow();
    });
  });

  describe("processor CLI end to end", () => {
    const env = (dbUrl: string) => ({ ...process.env, DATABASE_URL: dbUrl });

    test("migrates a fresh database on startup and serves /health", async () => {
      await db.close();
      const e2e = await target.fresh();
      try {
        // Port 0: the OS picks a free port, and the processor logs the URL it bound to.
        const proc = Bun.spawn(["bun", "run", "src/processor/cli.ts", "--port", "0", "--no-worker"], {
          env: env(e2e.url),
          stdout: "pipe",
        });
        try {
          const url = await listeningUrl(proc.stdout);
          const res = await fetch(new URL("/health", url));
          expect(res.status).toBe(200);
          expect(await res.json()).toMatchObject({ status: "ok", schemaVersion: SCHEMA_VERSION });
        } finally {
          proc.kill();
          await proc.exited;
        }
      } finally {
        await e2e.cleanup();
      }
    });
  });
});

test("the processor exits non-zero when the database URL has no driver", () => {
  const proc = Bun.spawnSync(["bun", "run", "src/processor/cli.ts"], {
    env: { ...process.env, DATABASE_URL: "mongodb://localhost/x" },
  });
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('No database driver for "mongodb:"');
});

test("unknown database URL schemes are rejected with the list of known drivers", async () => {
  await expect(migrateDatabase("mongodb://localhost/x")).rejects.toThrow(/No database driver for "mongodb:".*sqlite/);
});
