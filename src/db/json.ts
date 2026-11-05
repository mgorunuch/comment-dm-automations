import type { Dialect } from "./types";

/**
 * SQL for a JSON value bound at `placeholder` (e.g. "$1"; pass JSON.stringify(value)).
 * Postgres stores JSONB; SQLite stores validated, minified JSON text.
 * Reading a key is portable as `column ->> 'key'` on both.
 */
export function jsonParam(dialect: Dialect, placeholder: string): string {
  // Bun.SQL binds a JS string to a bare JSONB cast as a JSON *string* scalar; going through
  // TEXT makes Postgres parse it into an object.
  return dialect === "postgres" ? `CAST(CAST(${placeholder} AS TEXT) AS JSONB)` : `json(${placeholder})`;
}

/** Postgres returns JSONB already parsed; SQLite returns text. */
export function parseJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}
