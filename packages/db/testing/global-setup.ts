// Vitest global setup: starts one Postgres container for the whole test run and
// migrates a template database that `createTestDatabase` clones per test file.
// Packages whose tests use `@omniralph/db/testing` list it in `test.globalSetup`.
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { getContainerRuntimeClient } from "testcontainers";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../src/migrate.js";
import { TEMPLATE_DATABASE, withDatabase } from "./template.js";

export default async function setup(project: TestProject): Promise<(() => Promise<void>) | void> {
  const dockerAvailable = await getContainerRuntimeClient().then(
    () => true,
    () => false,
  );
  if (!dockerAvailable) {
    project.provide("testPostgresUri", undefined);
    return;
  }
  const container = await new PostgreSqlContainer("postgres:17-alpine")
    // Throwaway data: skip durability, keep it in memory, and allow a connection pool
    // per test file across every worker.
    .withCommand([
      "postgres",
      ...["-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"],
      ...["-c", "max_connections=1000"],
    ])
    .withTmpFs({ "/var/lib/postgresql/data": "rw" })
    .start();
  // Vitest only calls the returned teardown when setup succeeds: stop the container
  // ourselves if creating or migrating the template fails.
  try {
    const uri = container.getConnectionUri();
    const client = new pg.Client({ connectionString: uri });
    await client.connect();
    try {
      await client.query(`create database ${TEMPLATE_DATABASE}`);
    } finally {
      await client.end();
    }
    // Cloning needs the template to have no connections: runMigrations closes its own.
    await runMigrations(withDatabase(uri, TEMPLATE_DATABASE));
    project.provide("testPostgresUri", uri);
  } catch (error) {
    await container.stop();
    throw error;
  }
  return async () => {
    await container.stop();
  };
}
