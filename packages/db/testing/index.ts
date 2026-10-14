// Per-file Postgres databases for tests, cloned from the migrated template that
// `global-setup.ts` prepares in the test run's single container.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { TEMPLATE_DATABASE, withDatabase } from "./template.js";

/** A test file's own database; `stop` drops it. */
export interface TestDatabase {
  uri: string;
  stop(): Promise<void>;
}

/** Whether the run has a Postgres (a container runtime was available); tests skip without one. */
export function testDatabaseAvailable(): boolean {
  return inject("testPostgresUri") !== undefined;
}

/**
 * Creates a database for a test file, with every migration applied (a copy of the
 * template, which takes milliseconds rather than starting a container and migrating).
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUri = inject("testPostgresUri");
  if (!adminUri) {
    throw new Error("No test Postgres: tests that need one require a container runtime (Docker)");
  }
  const name = `test_${randomUUID().replaceAll("-", "")}`;
  await admin(adminUri, (client) =>
    client.query(`create database ${name} template ${TEMPLATE_DATABASE}`),
  );
  return {
    uri: withDatabase(adminUri, name),
    stop: () => admin(adminUri, (client) => client.query(`drop database ${name} with (force)`)),
  };
}

async function admin(uri: string, query: (client: pg.Client) => Promise<unknown>): Promise<void> {
  const client = new pg.Client({ connectionString: uri });
  await client.connect();
  try {
    await query(client);
  } finally {
    await client.end();
  }
}
