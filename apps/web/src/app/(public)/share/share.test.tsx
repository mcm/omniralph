import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  closeDb,
  createDb,
  createOrganization,
  saveIntegration,
  users,
  workItemShareLinks,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as LinearClient from "@/lib/linear/client";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import nextConfig from "../../../../next.config";

vi.mock("server-only", () => ({}));
// The link service (used to create links here) reaches the session through the API scope.
vi.mock("@/lib/auth/session", () => ({}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  cookies: new Map<string, string>(),
  linear: new Map<string, FakeLinearGateway>(),
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = state.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));
vi.mock("@/lib/linear/client", async (importOriginal) => {
  const actual = await importOriginal<typeof LinearClient>();
  return {
    ...actual,
    getLinearGateway: async (options: LinearClient.LinearGatewayOptions) => {
      const gateway = state.linear.get(options.organizationId);
      if (!gateway) throw new actual.LinearNotConnectedError();
      return gateway;
    },
  };
});

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "share-test-session-secret";

const { default: SharePage } = await import("./[token]/page");
const openRoute = await import("./[token]/open/route");
const { createShareLink } = await import("@/lib/work-items/share-link-service");
const { SHARE_ACCESS_COOKIE } = await import("@/lib/work-items/share-links");

const GONE = "This review link has expired or doesn&#x27;t exist.";

async function render(token: string): Promise<string> {
  return renderToStaticMarkup(await SharePage({ params: Promise.resolve({ token }) }));
}

function open(token: string, password: unknown, ip = "203.0.113.7") {
  return openRoute.POST(
    new Request(`http://localhost/share/${token}/open`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip },
      body: JSON.stringify({ password }),
    }),
    { params: Promise.resolve({ token }) },
  );
}

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("/share/{token}", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let acme: FakeLinearGateway;

  /** A link to a new item with a PRD and two stories; its token and ID. */
  const share = async (password = "") => {
    const epic = acme.add({
      title: "Customer portal login",
      description:
        "# PRD: Customer portal login\n\nSee [the spec](https://example.com/spec).\n\n## Quality Gates\n\n- `pnpm test`\n",
    });
    acme.add({
      title: "Store sessions",
      identifier: `ENG-${Math.floor(Math.random() * 9000) + 1000}`,
      parentId: epic.id,
      stateType: "unstarted",
      stateName: "Todo",
      subIssueSortOrder: 1,
    });
    acme.add({
      title: "Grant SSO access",
      parentId: epic.id,
      stateType: "started",
      stateName: "In Progress",
      labels: ["manual"],
      subIssueSortOrder: 2,
    });
    const created = await createShareLink(
      db,
      { key: { organizationId: orgId, tracker: "linear", externalId: epic.id } },
      { userId: "share-steve", name: "Steve McMaster" },
      { password, baseUrl: "https://omniralph.example.com" },
    );
    return { epic, token: created.url.split("/share/")[1]!, linkId: created.link.id };
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    await db.insert(users).values({ id: "share-steve", name: "Steve McMaster" });
    const org = await createOrganization(db, { name: "Acme", createdBy: "share-steve" });
    orgId = org.id;
    acme = new FakeLinearGateway();
    state.linear.set(orgId, acme);
    const integration = await saveIntegration(db, {
      organizationId: orgId,
      provider: "linear",
      externalId: "acme-share-page-workspace",
      name: "Acme",
      credentials: { accessToken: "t" },
      installedByUserId: null,
    });
    if (integration === "other_organization") throw new Error("setup");
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("renders the identifier, title, PRD and stories of a valid link", async () => {
    const { epic, token } = await share();
    state.cookies.clear();
    const html = await render(token);
    expect(html).toContain(epic.identifier);
    expect(html).toContain('<h1 class="share-title">Customer portal login</h1>');
    // The PRD through Markdown: headings, the numbered Quality Gates.
    expect(html).toContain("PRD: Customer portal login");
    expect(html).toMatch(/<ol class="or-md__gates">/);
    expect(html).toContain("Stories · 2");
    expect(html).toContain("Store sessions");
    expect(html).toContain("Todo");
    expect(html).toContain("Grant SSO access");
    expect(html).toContain("In Progress");
    expect(html).toContain("manual");
    expect(html).toMatch(/Shared by Steve McMaster · expires [A-Z][a-z]{2} \d{1,2}/);
    expect(html).not.toContain('type="password"');

    // It links nowhere into the app: only the PRD's own external links.
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["https://example.com/spec"]);
  });

  it("reads the item live: a PRD edited in the tracker shows on the next visit", async () => {
    const { epic, token } = await share();
    await acme.updateIssue(epic.id, { description: "# PRD: Rewritten" });
    expect(await render(token)).toContain("PRD: Rewritten");
  });

  it("asks for the password first; the right one sets an HTTP-only cookie for the link's path", async () => {
    const { epic, token } = await share("open sesame");
    state.cookies.clear();
    const locked = await render(token);
    expect(locked).toContain('type="password"');
    expect(locked).toContain(">Open<");
    expect(locked).not.toContain(epic.title);
    expect(locked).not.toContain("PRD: Customer portal login");

    const wrong = await open(token, "guess", "198.51.100.1");
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "That password isn't right." });
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const right = await open(token, "open sesame", "198.51.100.1");
    expect(right.status).toBe(204);
    const cookie = right.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${SHARE_ACCESS_COOKIE}=`));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toContain(`Path=/share/${token}`);
    expect(cookie).toMatch(/Max-Age=43200/);

    state.cookies.set(SHARE_ACCESS_COOKIE, decodeURIComponent(/=([^;]*)/.exec(cookie)![1]!));
    const opened = await render(token);
    expect(opened).toContain(epic.title);
    expect(opened).toContain("PRD: Customer portal login");

    // That cookie doesn't open another protected link.
    const other = await share("other");
    expect(await render(other.token)).toContain('type="password"');
    state.cookies.clear();
  });

  it("answers 429 to the 11th password attempt in a minute from one IP", async () => {
    // Every attempt in one fixed one-minute window, whatever the clock says.
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: now - (now % 60_000) + 1_000 });
    try {
      const { token } = await share("right");
      for (let i = 0; i < 10; i += 1) {
        expect((await open(token, `wrong-${i}`, "192.0.2.10")).status).toBe(401);
      }
      const limited = await open(token, "right", "192.0.2.10");
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: "Too many attempts. Try again in a minute." });
      expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(limited.headers.get("set-cookie")).toBeNull();
      // Another IP still gets its own attempts.
      expect((await open(token, "right", "192.0.2.11")).status).toBe(204);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the same page for revoked, expired and unknown links", async () => {
    state.cookies.clear();
    const revoked = await share();
    await db
      .update(workItemShareLinks)
      .set({ revokedAt: new Date() })
      .where(eq(workItemShareLinks.id, revoked.linkId));
    const expired = await share("pw");
    await db
      .update(workItemShareLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(workItemShareLinks.id, expired.linkId));

    const pages = await Promise.all([
      render(revoked.token),
      render(expired.token),
      render(randomBytes(32).toString("base64url")),
      render("not-a-token"),
    ]);
    expect(pages[0]).toContain(GONE);
    expect(new Set(pages).size).toBe(1);
    expect(pages[0]).not.toContain("Customer portal login");

    // An item deleted in the tracker too.
    const deleted = await share();
    acme.issues.delete(deleted.epic.id);
    expect(await render(deleted.token)).toBe(pages[0]);

    // The password route doesn't open them either.
    expect((await open(expired.token, "pw")).status).toBe(404);
    expect((await open("not-a-token", "pw")).status).toBe(404);
  });

  it("sends noindex and no-referrer on every share response", async () => {
    const { token } = await share("pw");
    for (const response of [
      await open(token, "nope"),
      await open(token, "pw"),
      await open("x", ""),
    ]) {
      expect(response.headers.get("x-robots-tag")).toBe("noindex");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
    const rules = await nextConfig.headers!();
    expect(rules).toContainEqual({
      source: "/share/:path*",
      headers: [
        { key: "X-Robots-Tag", value: "noindex" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ],
    });
  });
});

describe("the review page's modules", () => {
  const roots = [
    path.join(__dirname, ".."),
    path.join(__dirname, "../../../lib/work-items/share-page.ts"),
    path.join(__dirname, "../../../lib/work-items/share-links.ts"),
  ];
  const files = (entry: string): string[] =>
    statSync(entry).isDirectory()
      ? readdirSync(entry).flatMap((name) => files(path.join(entry, name)))
      : /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)
        ? [entry]
        : [];

  it("import nothing from the app's link or shell components", () => {
    const sources = roots.flatMap(files);
    expect(sources.length).toBeGreaterThanOrEqual(6);
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/@\/components\/(link|auth-shell|legal-shell)/);
      expect(source, file).not.toMatch(/from "next\/link"/);
    }
  });
});
