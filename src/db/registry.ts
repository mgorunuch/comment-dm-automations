import { postgresFactory } from "./drivers/postgres";
import { sqliteFactory } from "./drivers/sqlite";
import type { DriverFactory } from "./types";

const factories = new Map<string, DriverFactory>();

export function registerDriver(factory: DriverFactory): void {
  for (const scheme of factory.schemes) factories.set(scheme, factory);
}

export function factoryFor(url: string): DriverFactory {
  const scheme = url.split(":", 1)[0]!.toLowerCase();
  const factory = factories.get(scheme);
  if (!factory) {
    throw new Error(`No database driver for "${scheme}:" URLs. Known: ${[...factories.keys()].join(", ")}`);
  }
  return factory;
}

registerDriver(sqliteFactory);
registerDriver(postgresFactory);
