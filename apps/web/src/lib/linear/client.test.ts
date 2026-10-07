import { randomBytes } from "node:crypto";
import {
  closeDb,
  createDb,
  getIntegrationWithCredentials,
  integrations,
  organizations,
  runMigrations,
  saveIntegration,
  type Database,
} from "@omniralph/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinearCredentials } from "./oauth";

vi.mock("server-only", () => ({}));

const { getLinearGateway, LinearNotConnectedError } = await import("./client");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const key = randomBytes(32);
const config = { clientId: "client-1", clientSecret: "secret-1" };
const NOW = Date.parse("2026-10-06T12:00:00Z");
const minutes = (n: number) => new Date(NOW + n * 60_000).toISOString();

const token = { requests: [] as URLSearchParams[], counter: 0, delayMs: 0, fail: false };
const graphqlAuth: string[] = [];
const server = setupServer(
  http.post("https://api.linear.app/oauth/token", async ({ request }) => {
    token.requests.push(new URLSearchParams(await request.text()));
    if (token.delayMs) await new Promise((r) => setTimeout(r, token.delayMs));
    if (token.fail) return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
    token.counter += 1;
    return HttpResponse.json({
      access_token: `access-${token.counter + 1}`,
      refresh_token: `refresh-${token.counter + 1}`,
      expires_in: 24 * 3600,
      token_type: "Bearer",
    });
  }),
  http.post("https://api.linear.app/graphql", ({ request }) => {
    graphqlAuth.push(request.headers.get("authorization") ?? "");
    return HttpResponse.json({ data: { organization: { id: "org-1", name: "Acme" } } });
  }),
);

describe.skipIf(!dockerAvailable)("getLinearGateway", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let organizationId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org, other] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    organizationId = org!.id;
    otherOrgId = other!.id;
    server.listen({ onUnhandledFrame: "error" });
  }, 180_000);

  afterAll(async () => {
    server.close();
    if (db) await closeDb(db);
    await container?.stop();
  });

  beforeEach(async () => {
    await db.delete(integrations);
    Object.assign(token, { requests: [], counter: 0, delayMs: 0, fail: false });
    graphqlAuth.length = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  const install = (credentials: LinearCredentials) =>
    saveIntegration(
      db,
      {
        organizationId,
        provider: "linear",
        externalId: "org-1",
        name: "Acme",
        credentials,
        installedByUserId: null,
      },
      key,
    );
  const stored = async () =>
    (await getIntegrationWithCredentials<LinearCredentials>(db, organizationId, "linear", key))
      ?.credentials;
  const gateway = () => getLinearGateway({ db, organizationId, key, config, now: () => NOW });

  it("throws when no workspace is connected", async () => {
    await expect(gateway()).rejects.toBeInstanceOf(LinearNotConnectedError);
  });

  it("uses the organization's own workspace only", async () => {
    await install({ accessToken: "access-1" });
    await expect(
      getLinearGateway({ db, organizationId: otherOrgId, key, config, now: () => NOW }),
    ).rejects.toBeInstanceOf(LinearNotConnectedError);
  });

  it("uses a token that is valid for more than 5 minutes as is", async () => {
    await install({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: minutes(6) });
    await (await gateway()).getOrganization();
    expect(token.requests).toHaveLength(0);
    expect(graphqlAuth).toEqual(["Bearer access-1"]);
  });

  it("never refreshes a token without expiry or refresh token", async () => {
    await install({ accessToken: "legacy" });
    await (await gateway()).getOrganization();
    expect(token.requests).toHaveLength(0);
    expect(graphqlAuth).toEqual(["Bearer legacy"]);
  });

  it("refreshes a token within 5 minutes of expiry and persists it", async () => {
    await install({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: minutes(4) });
    await (await gateway()).getOrganization();
    expect(token.requests).toHaveLength(1);
    expect(token.requests[0]?.get("refresh_token")).toBe("refresh-1");
    expect(graphqlAuth).toEqual(["Bearer access-2"]);
    expect(await stored()).toEqual({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: new Date(NOW + 24 * 3600 * 1000).toISOString(),
    });
  });

  it("refreshes once for concurrent callers and stores consistent credentials", async () => {
    await install({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: minutes(-1) });
    token.delayMs = 50;
    const gateways = await Promise.all([gateway(), gateway(), gateway()]);
    await Promise.all(gateways.map((g) => g.getOrganization()));
    expect(token.requests).toHaveLength(1);
    expect(graphqlAuth).toEqual(["Bearer access-2", "Bearer access-2", "Bearer access-2"]);
    expect(await stored()).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
  });

  it("doesn't refresh again when another process refreshed while it waited for the lock", async () => {
    await install({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: minutes(-1) });
    token.delayMs = 50;
    // Two separate "processes": separate pools and no shared in-process dedupe.
    const otherDb = createDb(container.getConnectionUri());
    try {
      vi.resetModules();
      const other = await import("./client");
      const [a, b] = await Promise.all([
        gateway(),
        other.getLinearGateway({ db: otherDb, organizationId, key, config, now: () => NOW }),
      ]);
      await Promise.all([a.getOrganization(), b.getOrganization()]);
    } finally {
      await closeDb(otherDb);
    }
    // The second refresh saw the fresh token under the row lock: the rotated
    // refresh token is never overwritten by an older one.
    expect(token.requests).toHaveLength(1);
    expect(graphqlAuth).toEqual(["Bearer access-2", "Bearer access-2"]);
    expect(await stored()).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
  });

  it("with a refresh budget, uses the still-valid token when the refresh is slow", async () => {
    await install({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: minutes(4) });
    token.delayMs = 500;
    const started = Date.now();
    const fast = await getLinearGateway({
      db,
      organizationId,
      key,
      config,
      now: () => NOW,
      refreshTimeoutMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(400);
    await fast.getOrganization();
    expect(graphqlAuth).toEqual(["Bearer access-1"]);
    // The refresh finishes in the background, and later callers share it.
    const later = await gateway();
    await later.getOrganization();
    expect(token.requests).toHaveLength(1);
    expect(graphqlAuth).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect(await stored()).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
  });

  it("with a refresh budget, uses a fast refresh's token", async () => {
    await install({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: minutes(4) });
    await (
      await getLinearGateway({
        db,
        organizationId,
        key,
        config,
        now: () => NOW,
        refreshTimeoutMs: 5_000,
      })
    ).getOrganization();
    expect(graphqlAuth).toEqual(["Bearer access-2"]);
  });

  it("with a refresh budget, uses the still-valid token when the refresh fails", async () => {
    const before = { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: minutes(1) };
    await install(before);
    token.fail = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const g = await getLinearGateway({
      db,
      organizationId,
      key,
      config,
      now: () => NOW,
      refreshTimeoutMs: 5_000,
    });
    await g.getOrganization();
    expect(graphqlAuth).toEqual(["Bearer access-1"]);
    expect(await stored()).toEqual(before);
  });

  it("with a refresh budget, still waits for the refresh of an expired token", async () => {
    await install({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: minutes(-1) });
    token.delayMs = 200;
    const g = await getLinearGateway({
      db,
      organizationId,
      key,
      config,
      now: () => NOW,
      refreshTimeoutMs: 10,
    });
    await g.getOrganization();
    expect(graphqlAuth).toEqual(["Bearer access-2"]);
  });

  it("keeps the stored credentials when the refresh fails", async () => {
    const before = { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: minutes(1) };
    await install(before);
    token.fail = true;
    await expect(gateway()).rejects.toThrow(/400/);
    expect(await stored()).toEqual(before);
  });
});
