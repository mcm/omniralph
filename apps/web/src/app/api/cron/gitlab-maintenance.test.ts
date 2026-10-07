import { randomBytes } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  organizations,
  runMigrations,
  scmConnections,
  seedReviewProfiles,
  upsertScmConnection,
  type Database,
  type ScmConnection,
} from "@omniralph/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: undefined as unknown as Database }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));

process.env.CRON_SECRET = "cron-secret";

const { GET } = await import("./gitlab-maintenance/route");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const HEALTHY = "https://healthy.gitlab.example.com";
const BROKEN = "https://broken.gitlab.example.com";
const hookRequests: string[] = [];

const server = setupServer(
  http.all(`${HEALTHY}/api/v4/projects/:id/hooks*`, ({ request }) => {
    hookRequests.push(`${request.method} ${new URL(request.url).pathname}`);
  }),
  http.get(`${HEALTHY}/api/v4/user`, () =>
    HttpResponse.json({
      id: 42,
      username: "service_account_group_12_omniralph",
      name: "Omniralph",
    }),
  ),
  http.get(`${HEALTHY}/api/v4/personal_access_tokens/self`, () =>
    HttpResponse.json({ id: 7, scopes: ["api"], expires_at: "2099-01-01" }),
  ),
  http.get(`${HEALTHY}/api/v4/projects/10/hooks/100`, () =>
    HttpResponse.json({
      id: 100,
      merge_requests_events: true,
      note_events: true,
      pipeline_events: true,
      enable_ssl_verification: true,
    }),
  ),
  http.get(`${HEALTHY}/api/v4/projects/11/hooks/101`, () =>
    HttpResponse.json({ message: "404 Not Found" }, { status: 404 }),
  ),
  http.get(`${BROKEN}/api/v4/user`, () => HttpResponse.json({ message: "boom" }, { status: 500 })),
);

const cron = (secret?: string) =>
  GET(
    new Request("http://localhost/api/cron/gitlab-maintenance", {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    }),
  );

describe.skipIf(!dockerAvailable)("GET /api/cron/gitlab-maintenance", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    state.db = db;
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    await seedReviewProfiles(db, orgId);
    // After Testcontainers is done talking to Docker over HTTP.
    server.listen({ onUnhandledFrame: "error" });
  }, 120_000);

  afterAll(async () => {
    server.close();
    if (db) await closeDb(db);
    await container?.stop();
  });

  beforeEach(() => {
    hookRequests.length = 0;
  });

  afterEach(async () => {
    await db.delete(scmConnections);
  });

  async function gitlabConnection(baseUrl: string, externalId: string): Promise<ScmConnection> {
    const connection = await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "gitlab",
      name: `bot @ ${new URL(baseUrl).host}`,
      baseUrl,
      externalId,
      credentials: { token: "glpat-bot", webhookSecret: "secret" },
    });
    return connection!;
  }

  async function healthOf(id: string) {
    const [row] = await db.select().from(scmConnections).where(eq(scmConnections.id, id));
    return row!.health;
  }

  it("requires the cron secret", async () => {
    const connection = await gitlabConnection(HEALTHY, "42");
    expect((await cron()).status).toBe(401);
    expect((await cron("wrong")).status).toBe(401);
    expect(await healthOf(connection.id)).toBeNull();
  });

  it("replaces each connection's health; one failing check doesn't stop the others", async () => {
    const broken = await gitlabConnection(BROKEN, "1");
    const healthy = await gitlabConnection(HEALTHY, "42");
    const stale = { checkedAt: "2026-01-01T00:00:00.000Z", tokenExpiresAt: null, problems: [] };
    await db
      .update(scmConnections)
      .set({
        health: {
          ...stale,
          problems: [{ code: "token_invalid", message: "Old problem" }],
        },
      })
      .where(eq(scmConnections.id, healthy.id));
    await db.update(scmConnections).set({ health: stale }).where(eq(scmConnections.id, broken.id));
    const web = await connectRepository(db, {
      connectionId: healthy.id,
      provider: "gitlab",
      externalId: "10",
      fullPath: "acme/web",
      webhookId: "100",
    });
    const api = await connectRepository(db, {
      connectionId: healthy.id,
      provider: "gitlab",
      externalId: "11",
      fullPath: "acme/api",
      webhookId: "101",
    });
    // Disabled projects aren't checked.
    await connectRepository(db, {
      connectionId: healthy.id,
      provider: "gitlab",
      externalId: "12",
      fullPath: "acme/off",
      enabled: false,
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await cron("cron-secret");

    expect(await res.json()).toEqual({ checked: 1, problems: 1, failed: 1 });
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
    const health = await healthOf(healthy.id);
    expect(health).toEqual({
      checkedAt: expect.any(String),
      tokenExpiresAt: "2099-01-01",
      problems: [{ code: "webhook_missing", message: expect.any(String), repositoryId: api.id }],
    });
    expect(health!.problems.some((p) => p.repositoryId === web.id)).toBe(false);
    // The failed check keeps the previous health.
    expect(await healthOf(broken.id)).toEqual(stale);
    expect(hookRequests.sort()).toEqual([
      "GET /api/v4/projects/10/hooks/100",
      "GET /api/v4/projects/11/hooks/101",
    ]);
  });

  it("records an empty problem list for a healthy connection", async () => {
    const healthy = await gitlabConnection(HEALTHY, "42");
    await connectRepository(db, {
      connectionId: healthy.id,
      provider: "gitlab",
      externalId: "10",
      fullPath: "acme/web",
      webhookId: "100",
    });
    expect(await (await cron("cron-secret")).json()).toEqual({
      checked: 1,
      problems: 0,
      failed: 0,
    });
    expect(await healthOf(healthy.id)).toMatchObject({
      tokenExpiresAt: "2099-01-01",
      problems: [],
    });
  });
});
