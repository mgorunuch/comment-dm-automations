export type Dialect = "sqlite" | "postgres";

/**
 * A schema migration. Use a single string when the SQL is portable,
 * or a per-dialect map when it isn't.
 */
export interface Migration {
  readonly name: string;
  readonly up: string | Readonly<Record<Dialect, string>>;
}

/** Something that runs statements: the driver itself, or an open transaction. */
export interface Queryable {
  readonly dialect: Dialect;
  /**
   * Run one parameterized statement and return its rows.
   * Placeholders are $1, $2, ... on every dialect.
   */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

/**
 * The only surface the rest of the app may touch. Add a new database by
 * implementing this interface and registering a factory in ./registry.ts.
 */
export interface Driver extends Queryable {
  /** Throws if the database cannot serve a trivial query. */
  ping(): Promise<void>;
  /** Number of migrations already applied (0 = never spawned). */
  schemaVersion(): Promise<number>;
  /** Apply one migration atomically and record it as `version`. */
  applyMigration(sql: string, version: number): Promise<void>;
  /** Run `fn` atomically: commit if it resolves, roll back if it throws. */
  transaction<R>(fn: (tx: Queryable) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

export interface DriverFactory {
  /** URL schemes this factory handles, e.g. ["postgres", "postgresql"]. */
  readonly schemes: readonly string[];
  /** Connect, creating storage (e.g. a SQLite file) if it does not exist yet. */
  connect(url: string): Promise<Driver>;
}
