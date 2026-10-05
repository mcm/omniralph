import { createHmac } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GitHubAdapter } from "./adapter.js";
import type { AppJwtSigner } from "./app-jwt.js";

const API = "https://api.github.com";
const REPO = { fullPath: "acme/widgets" };
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const SECRET = "webhook-secret";

let now = Date.UTC(2026, 9, 4, 12, 0, 0);
let tokenRequests: { auth: string | null; body: Record<string, unknown> }[] = [];
let issued = 0;

/** Counts signatures so tests can assert on JWT caching. */
class FakeSigner implements AppJwtSigner {
  signed = 0;
  async sign(appId: string) {
    this.signed += 1;
    return { token: `jwt-${appId}-${this.signed}`, expiresAt: new Date(now + 540_000) };
  }
}

const server = setupServer(
  http.get(`${API}/repos/acme/widgets/installation`, ({ request }) => {
    if (!request.headers.get("authorization")?.startsWith("Bearer jwt-")) {
      return HttpResponse.json({ message: "Bad credentials" }, { status: 401 });
    }
    return HttpResponse.json({ id: 42 });
  }),
  http.post(`${API}/app/installations/42/access_tokens`, async ({ request }) => {
    const text = await request.text();
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    tokenRequests.push({ auth: request.headers.get("authorization"), body });
    issued += 1;
    return HttpResponse.json(
      {
        token: `ghs_${issued}`,
        expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
        permissions: body.permissions ?? { contents: "write", pull_requests: "write" },
      },
      { status: 201 },
    );
  }),
);

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => {
  now = Date.UTC(2026, 9, 4, 12, 0, 0);
  tokenRequests = [];
  issued = 0;
});

function makeAdapter(options: { installationId?: number; signer?: AppJwtSigner } = {}) {
  return new GitHubAdapter({
    appId: "123",
    signer: options.signer ?? new FakeSigner(),
    webhookSecret: SECRET,
    installationId: options.installationId,
    now: () => now,
  });
}

function pullHandler() {
  return http.get(`${API}/repos/acme/widgets/pulls/7`, () =>
    HttpResponse.json({
      number: 7,
      title: "Add widgets",
      body: null,
      user: { login: "octocat" },
      draft: true,
      base: { sha: BASE, ref: "main" },
      head: { sha: HEAD, ref: "feature" },
      html_url: "https://github.com/acme/widgets/pull/7",
    }),
  );
}

describe("installation tokens", () => {
  it("looks up the installation and caches the token until near expiry", async () => {
    const signer = new FakeSigner();
    const adapter = makeAdapter({ signer });
    server.use(pullHandler());

    await adapter.getChangeRequest(REPO, 7);
    await adapter.getChangeRequest(REPO, 7);
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.auth).toBe("Bearer jwt-123-1");
    expect(tokenRequests[0]?.body).toEqual({});

    // 56 minutes later the 1h token is inside the 5-minute refresh margin.
    now += 56 * 60 * 1000;
    await adapter.getChangeRequest(REPO, 7);
    expect(tokenRequests).toHaveLength(2);
    // The app JWT (540s) expired too, so it was re-signed.
    expect(tokenRequests[1]?.auth).toBe("Bearer jwt-123-2");
  });

  it("deduplicates concurrent token requests", async () => {
    const adapter = makeAdapter({ installationId: 42 });
    server.use(pullHandler());
    await Promise.all([adapter.getChangeRequest(REPO, 7), adapter.getChangeRequest(REPO, 7)]);
    expect(tokenRequests).toHaveLength(1);
  });

  it("does not cache failed token requests", async () => {
    const adapter = makeAdapter({ installationId: 42 });
    server.use(
      http.post(
        `${API}/app/installations/42/access_tokens`,
        () => HttpResponse.json({ message: "boom" }, { status: 500 }),
        { once: true },
      ),
    );
    await expect(adapter.getReadOnlyCloneCredential(REPO)).rejects.toMatchObject({ status: 500 });
    await expect(adapter.getReadOnlyCloneCredential(REPO)).resolves.toMatchObject({ token: "ghs_1" });
  });
});

describe("getReadOnlyCloneCredential", () => {
  it("requests a token limited to contents: read on the one repository", async () => {
    const adapter = makeAdapter();
    const credential = await adapter.getReadOnlyCloneCredential(REPO);

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.body).toEqual({ repositories: ["widgets"], permissions: { contents: "read" } });
    expect(credential).toEqual({
      cloneUrl: "https://github.com/acme/widgets.git",
      username: "x-access-token",
      token: "ghs_1",
      expiresAt: new Date(now + 60 * 60 * 1000),
    });

    // Cached separately from the unscoped installation token.
    await adapter.getReadOnlyCloneCredential(REPO);
    expect(tokenRequests).toHaveLength(1);
    server.use(pullHandler());
    await adapter.getChangeRequest(REPO, 7);
    expect(tokenRequests).toHaveLength(2);
    expect(tokenRequests[1]?.body).toEqual({});
  });

  it("derives the clone host for GitHub Enterprise Server", async () => {
    server.use(
      http.post("https://ghe.example.com/api/v3/app/installations/9/access_tokens", () =>
        HttpResponse.json({ token: "ghs_ghe", expires_at: new Date(now + 3_600_000).toISOString() }),
      ),
    );
    const adapter = new GitHubAdapter({
      appId: "1",
      signer: new FakeSigner(),
      webhookSecret: SECRET,
      installationId: 9,
      baseUrl: "https://ghe.example.com/api/v3",
    });
    const credential = await adapter.getReadOnlyCloneCredential(REPO);
    expect(credential.cloneUrl).toBe("https://ghe.example.com/acme/widgets.git");
  });
});

describe("getChangeRequest", () => {
  it("maps the pull request", async () => {
    server.use(pullHandler());
    const cr = await makeAdapter().getChangeRequest(REPO, 7);
    expect(cr).toEqual({
      number: 7,
      title: "Add widgets",
      description: "",
      author: "octocat",
      draft: true,
      baseSha: BASE,
      headSha: HEAD,
      baseRef: "main",
      headRef: "feature",
      url: "https://github.com/acme/widgets/pull/7",
    });
  });
});

describe("postReview", () => {
  const PATCH = ["@@ -10,3 +10,4 @@", " a", "-b", "+c", "+d", " e"].join("\n");
  let reviewBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    reviewBody = undefined;
    server.use(
      pullHandler(),
      http.get(`${API}/repos/acme/widgets/pulls/7/files`, () =>
        HttpResponse.json([
          { filename: "src/app.ts", patch: PATCH },
          { filename: "logo.png" },
        ]),
      ),
      http.post(`${API}/repos/acme/widgets/pulls/7/reviews`, async ({ request }) => {
        reviewBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 900 });
      }),
      http.get(`${API}/repos/acme/widgets/pulls/7/reviews/900/comments`, () => {
        const comments = (reviewBody?.comments ?? []) as { path: string; line: number; side: string }[];
        // Returned newest first to check the ID matching doesn't rely on order.
        return HttpResponse.json(
          comments.map((c, i) => ({ id: 1000 + i, path: c.path, line: c.line, side: c.side })).reverse(),
        );
      }),
    );
  });

  it("submits one review with inline comments and falls back for lines outside the diff", async () => {
    const posted = await makeAdapter().postReview(REPO, 7, {
      summary: "## Review\n2 findings",
      inlineComments: [
        { path: "src/app.ts", line: 12, body: "Check d." },
        { path: "src/app.ts", line: 99, body: "Outside the diff." },
        { path: "src/app.ts", startLine: 11, line: 12, body: "Simplify.", suggestion: "const cd = 1;" },
        { path: "src/app.ts", line: 11, side: "old", body: "Why remove b?" },
        { path: "logo.png", line: 1, body: "Binary." },
      ],
    });

    expect(reviewBody).toMatchObject({ commit_id: HEAD, event: "COMMENT" });
    expect(reviewBody?.comments).toEqual([
      { path: "src/app.ts", line: 12, side: "RIGHT", body: "Check d." },
      {
        path: "src/app.ts",
        line: 12,
        side: "RIGHT",
        start_line: 11,
        start_side: "RIGHT",
        body: "Simplify.\n\n```suggestion\nconst cd = 1;\n```",
      },
      { path: "src/app.ts", line: 11, side: "LEFT", body: "Why remove b?" },
    ]);
    const body = String(reviewBody?.body);
    expect(body.startsWith("## Review\n2 findings")).toBe(true);
    expect(body).toContain("**`src/app.ts`** L99\n\nOutside the diff.");
    expect(body).toContain("**`logo.png`** L1\n\nBinary.");

    expect(posted).toEqual({
      reviewId: "900",
      summaryCommentId: "900",
      inlineCommentIds: ["1000", null, "1001", "1002", null],
    });
  });

  it("validates lines against the reviewed commit when the head has moved", async () => {
    const reviewed = "c".repeat(40);
    server.use(
      http.get(`${API}/repos/acme/widgets/compare/${BASE}...${reviewed}`, () =>
        HttpResponse.json({ files: [{ filename: "src/other.ts", patch: "@@ -0,0 +1,1 @@\n+x" }] }),
      ),
    );
    const posted = await makeAdapter().postReview(REPO, 7, {
      summary: "S",
      commitSha: reviewed,
      inlineComments: [
        { path: "src/other.ts", line: 1, body: "In the reviewed diff." },
        { path: "src/app.ts", line: 12, body: "Only in the newer head." },
      ],
    });
    expect(reviewBody).toMatchObject({ commit_id: reviewed });
    expect(reviewBody?.comments).toEqual([
      { path: "src/other.ts", line: 1, side: "RIGHT", body: "In the reviewed diff." },
    ]);
    expect(posted.inlineCommentIds).toEqual(["1000", null]);
  });

  it("posts a summary-only review without listing comments", async () => {
    const posted = await makeAdapter().postReview(REPO, 7, { summary: "No findings.", inlineComments: [] });
    expect(reviewBody).toMatchObject({ body: "No findings.", comments: [] });
    expect(posted.inlineCommentIds).toEqual([]);
  });
});

describe("replyToComment and resolveThread", () => {
  it("posts a PR conversation comment", async () => {
    let posted: unknown;
    server.use(
      http.post(`${API}/repos/acme/widgets/issues/7/comments`, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ id: 4321 }, { status: 201 });
      }),
    );
    await expect(makeAdapter().postComment(REPO, 7, "Hello")).resolves.toEqual({ id: "4321" });
    expect(posted).toEqual({ body: "Hello" });
  });

  it("replies in the comment's thread", async () => {
    let replied: unknown;
    server.use(
      http.post(`${API}/repos/acme/widgets/pulls/7/comments/1000/replies`, async ({ request }) => {
        replied = await request.json();
        return HttpResponse.json({ id: 1234 }, { status: 201 });
      }),
    );
    await expect(makeAdapter().replyToComment(REPO, 7, "1000", "Thanks!")).resolves.toEqual({ id: "1234" });
    expect(replied).toEqual({ body: "Thanks!" });
  });

  it("finds the thread across pages and resolves it", async () => {
    const operations: { query: string; variables: Record<string, unknown> }[] = [];
    server.use(
      http.post(`${API}/graphql`, async ({ request }) => {
        const op = (await request.json()) as { query: string; variables: Record<string, unknown> };
        operations.push(op);
        if (op.query.includes("resolveReviewThread")) {
          return HttpResponse.json({ data: { resolveReviewThread: { thread: { id: op.variables.threadId } } } });
        }
        const firstPage = op.variables.cursor === null;
        return HttpResponse.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: firstPage, endCursor: firstPage ? "c1" : null },
                  nodes: firstPage
                    ? [{ id: "T1", isResolved: false, comments: { nodes: [{ databaseId: 1 }] } }]
                    : [{ id: "T2", isResolved: false, comments: { nodes: [{ databaseId: 1000 }] } }],
                },
              },
            },
          },
        });
      }),
    );
    await makeAdapter().resolveThread(REPO, 7, "1000");
    expect(operations).toHaveLength(3);
    expect(operations[1]?.variables).toMatchObject({ cursor: "c1", owner: "acme", repo: "widgets", number: 7 });
    expect(operations[2]?.variables).toEqual({ threadId: "T2" });
  });
});

describe("hasWriteAccess", () => {
  it.each([
    ["admin", "admin", true],
    ["write", "maintain", true],
    ["write", "write", true],
    ["read", "triage", false],
    ["read", "read", false],
  ])("permission %s / role %s → %s", async (permission, roleName, expected) => {
    server.use(
      http.get(`${API}/repos/acme/widgets/collaborators/someone/permission`, () =>
        HttpResponse.json({ permission, role_name: roleName }),
      ),
    );
    await expect(makeAdapter().hasWriteAccess(REPO, "someone")).resolves.toBe(expected);
  });

  it("returns false for non-collaborators", async () => {
    server.use(
      http.get(`${API}/repos/acme/widgets/collaborators/stranger/permission`, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    await expect(makeAdapter().hasWriteAccess(REPO, "stranger")).resolves.toBe(false);
  });
});

describe("verifyWebhook", () => {
  const body = JSON.stringify({ action: "opened", number: 7 });
  const sign = (payload: string, secret = SECRET) =>
    `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;

  it("accepts a valid X-Hub-Signature-256 (string or bytes, any header casing)", async () => {
    const adapter = makeAdapter();
    await expect(adapter.verifyWebhook({ "X-Hub-Signature-256": sign(body) }, body)).resolves.toBe(true);
    await expect(
      adapter.verifyWebhook(new Headers({ "x-hub-signature-256": sign(body) }), new TextEncoder().encode(body)),
    ).resolves.toBe(true);
  });

  it("rejects invalid, tampered or missing signatures", async () => {
    const adapter = makeAdapter();
    await expect(adapter.verifyWebhook({ "x-hub-signature-256": sign(body, "wrong") }, body)).resolves.toBe(false);
    await expect(adapter.verifyWebhook({ "x-hub-signature-256": sign(body) }, `${body} `)).resolves.toBe(false);
    await expect(adapter.verifyWebhook({ "x-hub-signature-256": "sha256=zz" }, body)).resolves.toBe(false);
    await expect(adapter.verifyWebhook({ "x-hub-signature-256": "garbage" }, body)).resolves.toBe(false);
    await expect(adapter.verifyWebhook({}, body)).resolves.toBe(false);
  });
});
