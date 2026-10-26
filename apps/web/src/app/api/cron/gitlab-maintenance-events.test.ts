import { randomBytes } from "node:crypto";
import {
  captureChanges,
  closeDb,
  createDb,
  listSettingsChanges,
  organizations,
  scmConnections,
  upsertScmConnection,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: undefined as unknown as Database }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));

process.env.CRON_SECRET = "cron-secret";

const { GET } = await import("./gitlab-maintenance/route");
const { changeMessage } = await import("@/lib/live/publisher");

const GITLAB = "https://events.gitlab.example.com";
/** Each bot's current token, by GitLab user. */
const tokens = new Map<string, string>();
let rotations = 0;
let rotateStatus = 200;

const userOf = (request: Request) =>
  [...tokens].find(([, token]) => token === request.headers.get("private-token"))?.[0];

const server = setupServer(
  http.get(`${GITLAB}/api/v4/user`, ({ request }) => {
    const user = userOf(request);
    return user
      ? HttpResponse.json({ id: Number(user), username: `bot${user}`, name: "Omniralph" })
      : HttpResponse.json({ message: "401 Unauthorized" }, { status: 401 });
  }),
  http.get(`${GITLAB}/api/v4/personal_access_tokens/self`, () =>
    HttpResponse.json({ id: 7, scopes: ["api"], expires_at: "2099-01-01" }),
  ),
  http.post(`${GITLAB}/api/v4/personal_access_tokens/self/rotate`, ({ request }) => {
    const user = userOf(request)!;
    if (rotateStatus !== 200) {
      return HttpResponse.json({ message: "404 Not Found" }, { status: rotateStatus });
    }
    rotations += 1;
    tokens.set(user, `glpat-${user}-rotated-${rotations}`);
    return HttpResponse.json({ id: 8, token: tokens.get(user), expires_at: "2099-01-01" });
  }),
);

describe.skipIf(!testDatabaseAvailable())("gitlab-maintenance cron: live events", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: string;
  let beta: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [acmeOrg, betaOrg] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Beta" }])
      .returning();
    acme = acmeOrg!.id;
    beta = betaOrg!.id;
    server.listen({ onUnhandledFrame: "error" });
  }, 120_000);

  afterAll(async () => {
    server.close();
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  afterEach(async () => {
    await db.delete(scmConnections);
    tokens.clear();
    rotateStatus = 200;
  });

  async function connection(organizationId: string, user: string) {
    tokens.set(user, `glpat-${user}`);
    return (await upsertScmConnection(db, {
      organizationId,
      provider: "gitlab",
      name: `bot${user} @ events.gitlab.example.com`,
      baseUrl: GITLAB,
      externalId: user,
      credentials: { token: `glpat-${user}`, webhookSecret: "secret" },
    }))!.id;
  }

  async function runCron() {
    const { result, changes } = await captureChanges(() =>
      GET(
        new Request("http://localhost/api/cron/gitlab-maintenance", {
          headers: { authorization: "Bearer cron-secret" },
        }),
      ),
    );
    expect(result.status).toBe(200);
    return changes.map((change) => changeMessage(change).event);
  }

  it("publishes one connection event per organization for the rotated and re-checked connections, and no settings change", async () => {
    const acmeId = await connection(acme, "1");
    const betaId = await connection(beta, "2");

    const events = await runCron();

    expect(rotations).toBe(2);
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "connection", ids: [acmeId], organizationId: acme }),
        expect.objectContaining({ resource: "connection", ids: [betaId], organizationId: beta }),
      ]),
    );
    // The cron has no actor: rotations aren't in the connections' change history.
    for (const [organizationId, subjectId] of [
      [acme, acmeId],
      [beta, betaId],
    ]) {
      const history = await listSettingsChanges(db, {
        organizationIds: [organizationId!],
        section: "connection",
        subjectId,
      });
      expect(history.entries).toEqual([]);
    }
  });

  it("publishes one connection event for a check without a rotation", async () => {
    rotateStatus = 404;
    const id = await connection(acme, "3");

    expect(await runCron()).toEqual([
      expect.objectContaining({ resource: "connection", ids: [id], organizationId: acme }),
    ]);
  });
});
