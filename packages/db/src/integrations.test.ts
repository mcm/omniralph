import { randomBytes } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Database } from "./client.js";
import { decrypt } from "./crypto.js";
import {
  consumeOAuthState,
  deleteIntegration,
  getIntegration,
  getIntegrationWithCredentials,
  saveIntegration,
  updateIntegrationCredentials,
} from "./integrations.js";
import { runMigrations } from "./migrate.js";
import { integrations, oauthStateUses, users } from "./schema.js";

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

  it("allows at most one integration per provider in the database", async () => {
    await install("org-1", "Acme", "t1");
    await expect(
      db.insert(integrations).values({ provider: "linear", externalId: "org-2", name: "Other", encryptedCredentials: "x" }),
    ).rejects.toThrow();
    expect((await db.select().from(integrations)).map((r) => r.externalId)).toEqual(["org-1"]);
  });

  it("ends concurrent installs of different workspaces with one row", async () => {
    const results = await Promise.allSettled([
      install("org-1", "Acme", "t1"),
      install("org-2", "Other", "t2"),
      install("org-3", "Third", "t3"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    const rows = await db.select().from(integrations);
    expect(rows).toHaveLength(1);
    const stored = await getIntegrationWithCredentials<Creds>(db, "linear", key);
    // The row and its credentials belong to the same install.
    expect({ "org-1": "t1", "org-2": "t2", "org-3": "t3" }[stored!.externalId]).toBe(stored!.credentials.accessToken);
  });

  it("consumes an OAuth state once and sweeps expired ones", async () => {
    await db.delete(oauthStateUses);
    const now = new Date("2026-10-06T12:00:00Z");
    const later = new Date(now.getTime() + 10 * 60_000);
    expect(await consumeOAuthState(db, "nonce-1", later, now)).toBe(true);
    expect(await consumeOAuthState(db, "nonce-1", later, now)).toBe(false);
    expect(await consumeOAuthState(db, "nonce-2", later, now)).toBe(true);
    const rows = await db.select().from(oauthStateUses);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.nonceHash)).not.toContain("nonce-1");

    // After both expire they are swept.
    expect(await consumeOAuthState(db, "nonce-3", new Date(later.getTime() + 60_000), new Date(later.getTime() + 1))).toBe(
      true,
    );
    expect(await db.select().from(oauthStateUses)).toHaveLength(1);
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
