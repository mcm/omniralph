import { randomBytes } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Database } from "./client.js";
import { decrypt } from "./crypto.js";
import {
  deleteIntegration,
  getIntegration,
  getIntegrationWithCredentials,
  saveIntegration,
  updateIntegrationCredentials,
} from "./integrations.js";
import { runMigrations } from "./migrate.js";
import { integrations, users } from "./schema.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

interface Creds {
  accessToken: string;
  version: number;
}

describe.skipIf(!dockerAvailable)("integration queries", () => {
  const key = randomBytes(32);
  let container: StartedPostgreSqlContainer;
  let db: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    await db.insert(users).values({ id: "admin-1", email: "admin@example.com", role: "admin" });
  }, 180_000);

  afterAll(async () => {
    await db?.$client.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.delete(integrations);
  });

  const install = (externalId: string, name: string, accessToken: string) =>
    saveIntegration<Creds>(
      db,
      { provider: "linear", externalId, name, credentials: { accessToken, version: 1 }, installedByUserId: "admin-1" },
      key,
    );

  it("stores credentials encrypted and reads them back", async () => {
    expect(await getIntegration(db, "linear")).toBeNull();
    const saved = await install("org-1", "Acme", "lin_secret_1");
    expect(saved).toMatchObject({ provider: "linear", externalId: "org-1", name: "Acme", installedByUserId: "admin-1" });
    expect(saved).not.toHaveProperty("encryptedCredentials");

    const [row] = await db.select().from(integrations);
    expect(row!.encryptedCredentials).not.toContain("lin_secret_1");
    expect(JSON.parse(decrypt(row!.encryptedCredentials, key))).toEqual({ accessToken: "lin_secret_1", version: 1 });

    expect(await getIntegration(db, "linear")).toMatchObject({ id: saved.id, name: "Acme" });
    expect((await getIntegrationWithCredentials<Creds>(db, "linear", key))?.credentials).toEqual({
      accessToken: "lin_secret_1",
      version: 1,
    });
  });

  it("is unique per provider and workspace; reinstalling updates the row", async () => {
    const first = await install("org-1", "Acme", "t1");
    const again = await install("org-1", "Acme Inc", "t2");
    expect(again.id).toBe(first.id);
    expect(again.name).toBe("Acme Inc");
    expect((await getIntegrationWithCredentials<Creds>(db, "linear", key))?.credentials.accessToken).toBe("t2");

    await expect(
      db.insert(integrations).values({ provider: "linear", externalId: "org-1", name: "dup", encryptedCredentials: "x" }),
    ).rejects.toThrow();
  });

  it("keeps only one workspace per provider", async () => {
    await install("org-1", "Acme", "t1");
    await install("org-2", "Other", "t2");
    const rows = await db.select().from(integrations);
    expect(rows.map((r) => r.externalId)).toEqual(["org-2"]);
  });

  it("deletes the integration and returns its credentials", async () => {
    await install("org-1", "Acme", "t1");
    const removed = await deleteIntegration<Creds>(db, "linear", key);
    expect(removed?.credentials.accessToken).toBe("t1");
    expect(await getIntegration(db, "linear")).toBeNull();
    expect(await deleteIntegration(db, "linear", key)).toBeNull();
  });

  it("serializes concurrent credential updates under a row lock", async () => {
    const { id } = await install("org-1", "Acme", "t1");
    const seen: number[] = [];
    const bump = () =>
      updateIntegrationCredentials<Creds>(
        db,
        id,
        async (current) => {
          seen.push(current.version);
          await new Promise((r) => setTimeout(r, 50));
          return { accessToken: `t${current.version + 1}`, version: current.version + 1 };
        },
        key,
      );
    const results = await Promise.all([bump(), bump(), bump()]);
    // Each update saw the previous one's result: no lost update.
    expect(seen.sort()).toEqual([1, 2, 3]);
    expect(results.map((r) => r?.version).sort()).toEqual([2, 3, 4]);
    expect((await getIntegrationWithCredentials<Creds>(db, "linear", key))?.credentials).toEqual({
      accessToken: "t4",
      version: 4,
    });

    // null keeps the current credentials.
    expect(await updateIntegrationCredentials<Creds>(db, id, async () => null, key)).toEqual({
      accessToken: "t4",
      version: 4,
    });
    expect(await updateIntegrationCredentials<Creds>(db, "00000000-0000-0000-0000-000000000000", async () => null, key)).toBeNull();
  });
});
