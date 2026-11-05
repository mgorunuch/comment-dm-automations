import type { Queryable } from "../db";

/** Max values per IN (...) list or rows per multi-row statement, to keep parameter counts bounded. */
export const SQL_CHUNK = 500;

/** Split `items` into consecutive slices of at most `size` (keeps SQL parameter counts bounded). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be at least 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `$from, $from+1, ...` for `count` parameters. */
export function placeholders(from: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `$${from + i}`).join(", ");
}

/**
 * Run `sql(inList)` for the distinct `values`, chunked, and concatenate the rows.
 * `prefix` holds parameters that come before the IN list ($1..$n).
 */
export async function selectIn<T>(
  q: Queryable,
  sql: (inList: string) => string,
  prefix: readonly unknown[],
  values: readonly string[],
): Promise<T[]> {
  const rows: T[] = [];
  for (const part of chunk([...new Set(values)], SQL_CHUNK)) {
    rows.push(...(await q.query<T>(sql(placeholders(prefix.length + 1, part.length)), [...prefix, ...part])));
  }
  return rows;
}
