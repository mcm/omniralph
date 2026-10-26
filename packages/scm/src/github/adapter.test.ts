import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_PATCH_LINES } from "../commit-diff.js";
import {
  ChangeRequestNotFoundError,
  CloneCredentialPermissionError,
  CommitNotFoundError,
} from "../types.js";
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
    await expect(adapter.getReadOnlyCloneCredential(REPO)).resolves.toMatchObject({
      token: "ghs_1",
    });
  });
});

describe("getReadOnlyCloneCredential", () => {
  it("requests a token limited to contents: read on the one repository", async () => {
    const adapter = makeAdapter();
    const credential = await adapter.getReadOnlyCloneCredential(REPO);

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.body).toEqual({
      repositories: ["widgets"],
      permissions: { contents: "read" },
    });
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
        HttpResponse.json({
          token: "ghs_ghe",
          expires_at: new Date(now + 3_600_000).toISOString(),
        }),
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

describe("getWriteCloneCredential", () => {
  it("requests a token limited to contents and workflows: write on the one repository, expiring within an hour", async () => {
    const adapter = makeAdapter();
    const credential = await adapter.getWriteCloneCredential(REPO);

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.body).toEqual({
      repositories: ["widgets"],
      permissions: { contents: "write", workflows: "write" },
    });
    expect(credential).toEqual({
      cloneUrl: "https://github.com/acme/widgets.git",
      username: "x-access-token",
      token: "ghs_1",
      expiresAt: new Date(now + 60 * 60 * 1000),
    });
    expect(credential.expiresAt.getTime() - now).toBeLessThanOrEqual(60 * 60 * 1000);

    // Never served from (or into) the read-only token's cache entry.
    const read = await adapter.getReadOnlyCloneCredential(REPO);
    expect(read.token).toBe("ghs_2");
    expect(tokenRequests[1]?.body).toEqual({
      repositories: ["widgets"],
      permissions: { contents: "read" },
    });
    await adapter.getWriteCloneCredential(REPO);
    expect(tokenRequests).toHaveLength(2);
  });

  it("falls back to contents: write when the installation hasn't granted workflows", async () => {
    server.use(
      http.post(`${API}/app/installations/42/access_tokens`, async ({ request }) => {
        const body = (await request.json()) as { permissions?: Record<string, string> };
        tokenRequests.push({ auth: request.headers.get("authorization"), body });
        if (body.permissions?.workflows) {
          return HttpResponse.json(
            {
              message:
                "The level of access for permissions requested are not granted to this installation.",
              status: "422",
            },
            { status: 422 },
          );
        }
        return HttpResponse.json(
          {
            token: "ghs_contents",
            expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
            permissions: body.permissions,
          },
          { status: 201 },
        );
      }),
    );
    const credential = await makeAdapter().getWriteCloneCredential(REPO);

    expect(credential.token).toBe("ghs_contents");
    expect(tokenRequests.map((r) => r.body)).toEqual([
      { repositories: ["widgets"], permissions: { contents: "write", workflows: "write" } },
      { repositories: ["widgets"], permissions: { contents: "write" } },
    ]);
  });

  it("does not fall back on a 422 that isn't about permissions", async () => {
    server.use(
      http.post(`${API}/app/installations/42/access_tokens`, async ({ request }) => {
        tokenRequests.push({
          auth: request.headers.get("authorization"),
          body: (await request.json()) as Record<string, unknown>,
        });
        return HttpResponse.json(
          {
            message:
              "There is at least one repository that does not exist or is not accessible to the parent installation.",
            status: "422",
          },
          { status: 422 },
        );
      }),
    );
    const error = await makeAdapter()
      .getWriteCloneCredential(REPO)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 422 });
    expect(tokenRequests).toHaveLength(1);
  });

  it("explains a missing Contents permission instead of failing with GitHub's 422", async () => {
    server.use(
      http.post(`${API}/app/installations/42/access_tokens`, () =>
        HttpResponse.json(
          {
            message:
              "The level of access for permissions requested are not granted to this installation.",
            status: "422",
          },
          { status: 422 },
        ),
      ),
    );
    const adapter = makeAdapter();
    const error = await adapter.getWriteCloneCredential(REPO).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloneCredentialPermissionError);
    expect(error).toMatchObject({ repo: REPO, access: "write" });
    expect((error as Error).message).toContain("Contents: Read and write");
    expect((error as Error).message).toContain("acme/widgets");
    expect((error as Error).cause).toMatchObject({ status: 422 });

    await expect(adapter.getReadOnlyCloneCredential(REPO)).rejects.toMatchObject({
      name: "CloneCredentialPermissionError",
      access: "read",
    });
  });

  it("passes through a 422 that isn't about permissions", async () => {
    server.use(
      http.post(`${API}/app/installations/42/access_tokens`, () =>
        HttpResponse.json(
          {
            message:
              "There is at least one repository that does not exist or is not accessible to the parent installation.",
            status: "422",
          },
          { status: 422 },
        ),
      ),
    );
    const error = await makeAdapter()
      .getWriteCloneCredential(REPO)
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(CloneCredentialPermissionError);
    expect(error).toMatchObject({ status: 422 });
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
      state: "open",
      baseSha: BASE,
      headSha: HEAD,
      baseRef: "main",
      headRef: "feature",
      url: "https://github.com/acme/widgets/pull/7",
    });
  });

  it("maps closed and merged pull requests", async () => {
    for (const [fields, state] of [
      [{ state: "closed", merged: false }, "closed"],
      [{ state: "closed", merged: true }, "merged"],
      [{ state: "open", merged: false }, "open"],
    ] as const) {
      server.use(
        http.get(`${API}/repos/acme/widgets/pulls/7`, () =>
          HttpResponse.json({
            number: 7,
            title: "Add widgets",
            body: null,
            user: { login: "octocat" },
            ...fields,
            base: { sha: BASE, ref: "main" },
            head: { sha: HEAD, ref: "feature" },
            html_url: "https://github.com/acme/widgets/pull/7",
          }),
        ),
      );
      expect((await makeAdapter().getChangeRequest(REPO, 7)).state).toBe(state);
    }
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
        HttpResponse.json([{ filename: "src/app.ts", patch: PATCH }, { filename: "logo.png" }]),
      ),
      http.post(`${API}/repos/acme/widgets/pulls/7/reviews`, async ({ request }) => {
        reviewBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 900 });
      }),
      // Like GitHub, the review's own listing leaves out the anchors.
      http.get(`${API}/repos/acme/widgets/pulls/7/reviews/900/comments`, () => {
        const comments = (reviewBody?.comments ?? []) as { path: string }[];
        return HttpResponse.json(
          comments.map((c, i) => ({ id: 1000 + i, path: c.path, line: null, side: null })),
        );
      }),
      http.get(`${API}/repos/acme/widgets/pulls/7/comments`, () => {
        const comments = (reviewBody?.comments ?? []) as {
          path: string;
          line: number;
          side: string;
        }[];
        // Returned newest first to check the ID matching doesn't rely on order,
        // with another review's comment on the same anchor.
        return HttpResponse.json([
          ...comments
            .map((c, i) => ({
              id: 1000 + i,
              pull_request_review_id: 900,
              path: c.path,
              line: c.line,
              side: c.side,
            }))
            .reverse(),
          { id: 500, pull_request_review_id: 800, path: "src/app.ts", line: 12, side: "RIGHT" },
        ]);
      }),
    );
  });

  it("submits one review with inline comments and falls back for lines outside the diff", async () => {
    const posted = await makeAdapter().postReview(REPO, 7, {
      summary: "## Review\n2 findings",
      inlineComments: [
        { path: "src/app.ts", line: 12, body: "Check d." },
        { path: "src/app.ts", line: 99, body: "Outside the diff." },
        {
          path: "src/app.ts",
          startLine: 11,
          line: 12,
          body: "Simplify.",
          suggestion: "const cd = 1;",
        },
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
    const posted = await makeAdapter().postReview(REPO, 7, {
      summary: "No findings.",
      inlineComments: [],
    });
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

  it("edits a comment in place", async () => {
    let edited: unknown;
    server.use(
      http.patch(`${API}/repos/acme/widgets/issues/comments/555`, async ({ request }) => {
        edited = await request.json();
        return HttpResponse.json({ id: 555 });
      }),
    );
    await expect(makeAdapter().upsertComment(REPO, 7, "Updated", "555")).resolves.toEqual({
      id: "555",
    });
    expect(edited).toEqual({ body: "Updated" });
  });

  it.each([
    ["no comment ID", null],
    ["a deleted comment", "555"],
  ])("creates a comment for %s", async (_name, commentId) => {
    let posted: unknown;
    server.use(
      http.patch(`${API}/repos/acme/widgets/issues/comments/555`, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
      http.post(`${API}/repos/acme/widgets/issues/7/comments`, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ id: 4322 }, { status: 201 });
      }),
    );
    await expect(makeAdapter().upsertComment(REPO, 7, "Fresh", commentId)).resolves.toEqual({
      id: "4322",
    });
    expect(posted).toEqual({ body: "Fresh" });
  });

  it("doesn't create a comment when editing fails otherwise", async () => {
    let created = false;
    server.use(
      http.patch(`${API}/repos/acme/widgets/issues/comments/555`, () =>
        HttpResponse.json({ message: "Forbidden" }, { status: 403 }),
      ),
      http.post(`${API}/repos/acme/widgets/issues/7/comments`, () => {
        created = true;
        return HttpResponse.json({ id: 1 }, { status: 201 });
      }),
    );
    await expect(makeAdapter().upsertComment(REPO, 7, "Body", "555")).rejects.toMatchObject({
      status: 403,
    });
    expect(created).toBe(false);
  });

  it("replies in the comment's thread", async () => {
    let replied: unknown;
    server.use(
      http.post(`${API}/repos/acme/widgets/pulls/7/comments/1000/replies`, async ({ request }) => {
        replied = await request.json();
        return HttpResponse.json({ id: 1234 }, { status: 201 });
      }),
    );
    await expect(makeAdapter().replyToComment(REPO, 7, "1000", "Thanks!")).resolves.toEqual({
      id: "1234",
    });
    expect(replied).toEqual({ body: "Thanks!" });
  });

  it("finds the thread across pages and resolves it", async () => {
    const operations: { query: string; variables: Record<string, unknown> }[] = [];
    server.use(
      http.post(`${API}/graphql`, async ({ request }) => {
        const op = (await request.json()) as { query: string; variables: Record<string, unknown> };
        operations.push(op);
        if (op.query.includes("resolveReviewThread")) {
          return HttpResponse.json({
            data: { resolveReviewThread: { thread: { id: op.variables.threadId } } },
          });
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
                    : [
                        {
                          id: "T2",
                          isResolved: false,
                          comments: { nodes: [{ databaseId: 1000 }] },
                        },
                      ],
                },
              },
            },
          },
        });
      }),
    );
    await makeAdapter().resolveThread(REPO, 7, "1000");
    expect(operations).toHaveLength(3);
    expect(operations[1]?.variables).toMatchObject({
      cursor: "c1",
      owner: "acme",
      repo: "widgets",
      number: 7,
    });
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
    await expect(adapter.verifyWebhook({ "X-Hub-Signature-256": sign(body) }, body)).resolves.toBe(
      true,
    );
    await expect(
      adapter.verifyWebhook(
        new Headers({ "x-hub-signature-256": sign(body) }),
        new TextEncoder().encode(body),
      ),
    ).resolves.toBe(true);
  });

  it("rejects invalid, tampered or missing signatures", async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.verifyWebhook({ "x-hub-signature-256": sign(body, "wrong") }, body),
    ).resolves.toBe(false);
    await expect(
      adapter.verifyWebhook({ "x-hub-signature-256": sign(body) }, `${body} `),
    ).resolves.toBe(false);
    await expect(adapter.verifyWebhook({ "x-hub-signature-256": "sha256=zz" }, body)).resolves.toBe(
      false,
    );
    await expect(adapter.verifyWebhook({ "x-hub-signature-256": "garbage" }, body)).resolves.toBe(
      false,
    );
    await expect(adapter.verifyWebhook({}, body)).resolves.toBe(false);
  });
});

describe("pull request operations", () => {
  const PULLS = `${API}/repos/acme/widgets/pulls`;
  const PR_URL = "https://github.com/acme/widgets/pull/12";

  async function jsonBody(request: Request): Promise<Record<string, unknown>> {
    return (await request.json()) as Record<string, unknown>;
  }

  it("reads the default branch", async () => {
    server.use(
      http.get(`${API}/repos/acme/widgets`, () => HttpResponse.json({ default_branch: "trunk" })),
    );
    await expect(makeAdapter({ installationId: 42 }).getDefaultBranch(REPO)).resolves.toBe("trunk");
  });

  it("finds the open pull request for a branch of this repository", async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      http.get(PULLS, ({ request }) => {
        const query = new URL(request.url).searchParams;
        queries.push(query);
        if (query.get("head") !== "acme:ralph/epic") return HttpResponse.json([]);
        return HttpResponse.json([{ number: 12, html_url: PR_URL, draft: true }]);
      }),
    );
    const adapter = makeAdapter({ installationId: 42 });
    await expect(adapter.findOpenChangeRequest(REPO, "ralph/epic")).resolves.toEqual({
      number: 12,
      url: PR_URL,
      draft: true,
    });
    expect(queries[0]?.get("state")).toBe("open");
    await expect(adapter.findOpenChangeRequest(REPO, "other")).resolves.toBeNull();
  });

  it("creates a draft pull request", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(PULLS, async ({ request }) => {
        body = await jsonBody(request);
        return HttpResponse.json({ number: 12, html_url: PR_URL }, { status: 201 });
      }),
    );
    const created = await makeAdapter({ installationId: 42 }).createChangeRequest(REPO, {
      sourceBranch: "ralph/epic",
      targetBranch: "main",
      title: "Build the epic",
      body: "## Summary\n\nDone.",
      draft: true,
    });
    expect(created).toEqual({ number: 12, url: PR_URL, created: true });
    expect(body).toEqual({
      head: "ralph/epic",
      base: "main",
      title: "Build the epic",
      body: "## Summary\n\nDone.",
      draft: true,
    });
  });

  it("caps the title and body", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(PULLS, async ({ request }) => {
        body = await jsonBody(request);
        return HttpResponse.json({ number: 12, html_url: PR_URL }, { status: 201 });
      }),
    );
    await makeAdapter({ installationId: 42 }).createChangeRequest(REPO, {
      sourceBranch: "ralph/epic",
      targetBranch: "main",
      title: "t".repeat(300),
      body: "b".repeat(70_000),
      draft: false,
    });
    expect((body.title as string).length).toBe(256);
    expect((body.title as string).endsWith("…")).toBe(true);
    expect((body.body as string).length).toBe(65_536);
    expect(body.draft).toBe(false);
  });

  it("recovers from 'already exists' by returning the open pull request", async () => {
    server.use(
      http.post(PULLS, () =>
        HttpResponse.json(
          {
            message: "Validation Failed",
            errors: [
              {
                resource: "PullRequest",
                code: "custom",
                message: "A pull request already exists for acme:ralph/epic.",
              },
            ],
          },
          { status: 422 },
        ),
      ),
      http.get(PULLS, () =>
        HttpResponse.json([
          { number: 9, html_url: "https://github.com/acme/widgets/pull/9", draft: false },
        ]),
      ),
    );
    const created = await makeAdapter({ installationId: 42 }).createChangeRequest(REPO, {
      sourceBranch: "ralph/epic",
      targetBranch: "main",
      title: "Build the epic",
      body: "",
      draft: true,
    });
    expect(created).toEqual({
      number: 9,
      url: "https://github.com/acme/widgets/pull/9",
      created: false,
    });
  });

  it("propagates other validation errors", async () => {
    server.use(
      http.post(PULLS, () =>
        HttpResponse.json(
          {
            message: "Validation Failed",
            errors: [{ message: "No commits between main and ralph/epic" }],
          },
          { status: 422 },
        ),
      ),
    );
    await expect(
      makeAdapter({ installationId: 42 }).createChangeRequest(REPO, {
        sourceBranch: "ralph/epic",
        targetBranch: "main",
        title: "Build the epic",
        body: "",
        draft: false,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("updates only the given fields", async () => {
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.patch(`${PULLS}/12`, async ({ request }) => {
        bodies.push(await jsonBody(request));
        return HttpResponse.json({ number: 12 });
      }),
    );
    const adapter = makeAdapter({ installationId: 42 });
    await adapter.updateChangeRequest(REPO, 12, { title: "New title", body: "New body" });
    await adapter.updateChangeRequest(REPO, 12, { body: "Only body" });
    expect(bodies).toEqual([{ title: "New title", body: "New body" }, { body: "Only body" }]);
  });

  it("throws ChangeRequestNotFoundError when updating a missing pull request", async () => {
    server.use(
      http.patch(`${PULLS}/404`, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    const error = await makeAdapter({ installationId: 42 })
      .updateChangeRequest(REPO, 404, { body: "x" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChangeRequestNotFoundError);
    expect(error).toMatchObject({
      number: 404,
      message: "Change request acme/widgets#404 not found",
    });
  });

  it("marks a draft ready through the GraphQL mutation", async () => {
    const graphql: { query: string; variables: Record<string, unknown> }[] = [];
    server.use(
      http.get(`${PULLS}/12`, () =>
        HttpResponse.json({ number: 12, node_id: "PR_node12", draft: true }),
      ),
      http.post(`${API}/graphql`, async ({ request }) => {
        graphql.push((await request.json()) as (typeof graphql)[number]);
        return HttpResponse.json({
          data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
        });
      }),
    );
    await makeAdapter({ installationId: 42 }).markChangeRequestReady(REPO, 12);
    expect(graphql).toHaveLength(1);
    expect(graphql[0]?.query).toContain("markPullRequestReadyForReview");
    expect(graphql[0]?.variables).toEqual({ pullRequestId: "PR_node12" });
  });

  it("does nothing when the pull request isn't a draft", async () => {
    let mutations = 0;
    server.use(
      http.get(`${PULLS}/12`, () =>
        HttpResponse.json({ number: 12, node_id: "PR_node12", draft: false }),
      ),
      http.post(`${API}/graphql`, () => {
        mutations += 1;
        return HttpResponse.json({ data: {} });
      }),
    );
    await makeAdapter({ installationId: 42 }).markChangeRequestReady(REPO, 12);
    expect(mutations).toBe(0);
  });

  it("throws ChangeRequestNotFoundError when marking a missing pull request ready", async () => {
    server.use(
      http.get(`${PULLS}/404`, () => HttpResponse.json({ message: "Not Found" }, { status: 404 })),
    );
    await expect(
      makeAdapter({ installationId: 42 }).markChangeRequestReady(REPO, 404),
    ).rejects.toBeInstanceOf(ChangeRequestNotFoundError);
  });
});

describe("CI status and pull request state", () => {
  const PULLS = `${API}/repos/acme/widgets/pulls`;
  const RUNS = `${API}/repos/acme/widgets/actions/runs`;

  function pull(fields: Record<string, unknown> = {}) {
    return http.get(`${PULLS}/7`, () =>
      HttpResponse.json({
        number: 7,
        state: "open",
        merged: false,
        head: { sha: HEAD, ref: "feature" },
        ...fields,
      }),
    );
  }

  function runs(workflowRuns: Record<string, unknown>[], seen: URL[] = []) {
    return http.get(RUNS, ({ request }) => {
      seen.push(new URL(request.url));
      return HttpResponse.json({ total_count: workflowRuns.length, workflow_runs: workflowRuns });
    });
  }

  function jobs(runId: number, list: Record<string, unknown>[]) {
    return http.get(`${RUNS}/${runId}/jobs`, () =>
      HttpResponse.json({ total_count: list.length, jobs: list }),
    );
  }

  const run = (fields: Record<string, unknown>) => ({
    workflow_id: 10,
    event: "pull_request",
    name: "CI",
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/acme/widgets/actions/runs/${String(fields.id)}`,
    ...fields,
  });

  it("reports the failed jobs of the head commit's newest run per workflow", async () => {
    const seen: URL[] = [];
    server.use(
      pull(),
      runs(
        [
          run({ id: 1, conclusion: "success" }),
          run({ id: 2, conclusion: "failure" }),
          run({ id: 3, workflow_id: 11, name: "Lint", conclusion: "success" }),
          // The same workflow for another event counts separately.
          run({ id: 4, event: "push", conclusion: "timed_out" }),
        ],
        seen,
      ),
      jobs(2, [
        {
          id: 20,
          name: "test",
          conclusion: "failure",
          html_url: "https://github.com/acme/widgets/actions/runs/2/job/20",
        },
        { id: 21, name: "build", conclusion: "success", html_url: null },
      ]),
      jobs(4, [{ id: 40, name: "deploy", conclusion: "timed_out", html_url: "https://gh/job/40" }]),
    );
    const status = await makeAdapter({ installationId: 42 }).getCiStatus(REPO, 7);
    expect(seen[0]?.searchParams.get("head_sha")).toBe(HEAD);
    expect(status).toEqual({
      state: "failed",
      headSha: HEAD,
      failedJobs: [
        {
          id: "20",
          name: "CI / test",
          url: "https://github.com/acme/widgets/actions/runs/2/job/20",
          noLog: false,
        },
        { id: "40", name: "CI / deploy", url: "https://gh/job/40", noLog: false },
      ],
    });
  });

  it("lists a failed run without failed jobs (startup_failure) as the run itself, without a log", async () => {
    server.use(pull(), runs([run({ id: 5, conclusion: "startup_failure" })]), jobs(5, []));
    await expect(makeAdapter({ installationId: 42 }).getCiStatus(REPO, 7)).resolves.toEqual({
      state: "failed",
      headSha: HEAD,
      failedJobs: [
        { id: "5", name: "CI", url: "https://github.com/acme/widgets/actions/runs/5", noLog: true },
      ],
    });
  });

  it("is pending while the newest run of a workflow is incomplete", async () => {
    server.use(
      pull(),
      runs([
        run({ id: 2, conclusion: "failure" }),
        run({ id: 4, status: "in_progress", conclusion: null }),
      ]),
    );
    await expect(makeAdapter({ installationId: 42 }).getCiStatus(REPO, 7)).resolves.toEqual({
      state: "pending",
      headSha: HEAD,
      failedJobs: [],
    });
  });

  it("passes when no newest run failed (cancelled and skipped runs don't fail it)", async () => {
    server.use(
      pull(),
      runs([
        run({ id: 1, conclusion: "failure" }),
        run({ id: 2, conclusion: "success" }),
        run({ id: 3, workflow_id: 11, conclusion: "cancelled" }),
        run({ id: 4, workflow_id: 12, conclusion: "skipped" }),
      ]),
    );
    await expect(makeAdapter({ installationId: 42 }).getCiStatus(REPO, 7)).resolves.toEqual({
      state: "passed",
      headSha: HEAD,
      failedJobs: [],
    });
  });

  it("is none when the head commit has no runs", async () => {
    server.use(pull(), runs([]));
    await expect(makeAdapter({ installationId: 42 }).getCiStatus(REPO, 7)).resolves.toEqual({
      state: "none",
      headSha: HEAD,
      failedJobs: [],
    });
  });

  it("throws ChangeRequestNotFoundError for a missing pull request", async () => {
    server.use(
      http.get(`${PULLS}/404`, () => HttpResponse.json({ message: "Not Found" }, { status: 404 })),
    );
    const adapter = makeAdapter({ installationId: 42 });
    await expect(adapter.getCiStatus(REPO, 404)).rejects.toBeInstanceOf(ChangeRequestNotFoundError);
    await expect(adapter.getChangeRequestState(REPO, 404)).rejects.toBeInstanceOf(
      ChangeRequestNotFoundError,
    );
  });

  it("reads a job's log through the jobs log API redirect, cleaned and cut to its tail", async () => {
    server.use(
      http.get(
        `${API}/repos/acme/widgets/actions/jobs/20/logs`,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { location: "https://logs.example.com/job/20.txt" },
          }),
      ),
      http.get("https://logs.example.com/job/20.txt", () =>
        HttpResponse.text(
          `${"x".repeat(5000)}\n2026-10-06T00:00:00Z \u001b[31mFAIL\u001b[0m a.test.ts\r\n`,
        ),
      ),
    );
    const log = await makeAdapter({ installationId: 42 }).getCiJobLog(REPO, "20");
    expect(log.startsWith("…")).toBe(true);
    expect(log).toHaveLength(4001);
    expect(log.endsWith("\n2026-10-06T00:00:00Z FAIL a.test.ts\n")).toBe(true);
  });

  it("reads open, closed and merged pull requests", async () => {
    const adapter = makeAdapter({ installationId: 42 });
    server.use(pull({ merge_commit_sha: "t".repeat(40) }));
    await expect(adapter.getChangeRequestState(REPO, 7)).resolves.toEqual({
      state: "open",
      headSha: HEAD,
      mergeSha: null,
    });
    server.use(pull({ state: "closed", merged_at: null, merge_commit_sha: "t".repeat(40) }));
    await expect(adapter.getChangeRequestState(REPO, 7)).resolves.toEqual({
      state: "closed",
      headSha: HEAD,
      mergeSha: null,
    });
    server.use(
      pull({
        state: "closed",
        merged: true,
        merged_at: "2026-10-06T00:00:00Z",
        merge_commit_sha: "m".repeat(40),
      }),
    );
    await expect(adapter.getChangeRequestState(REPO, 7)).resolves.toEqual({
      state: "merged",
      headSha: HEAD,
      mergeSha: "m".repeat(40),
    });
  });
});

describe("getCommitDiff", () => {
  /** A recorded `GET /repos/{owner}/{repo}/commits/{sha}` response. */
  const commit = JSON.parse(
    readFileSync(new URL("./fixtures/commit.json", import.meta.url), "utf8"),
  ) as { sha: string; files: Record<string, unknown>[] };
  const SHA = commit.sha;
  const COMMIT_URL = `${API}/repos/acme/widgets/commits/${SHA}`;

  it("maps the commit's files, statuses, counts and patches", async () => {
    const adapter = makeAdapter({ installationId: 42 });
    let perPage: string | null = null;
    server.use(
      http.get(COMMIT_URL, ({ request }) => {
        perPage = new URL(request.url).searchParams.get("per_page");
        return HttpResponse.json(commit);
      }),
    );
    const diff = await adapter.getCommitDiff(REPO, SHA);
    expect(perPage).toBe("101");
    expect(diff.sha).toBe(SHA);
    expect(diff.url).toBe(`https://github.com/acme/widgets/commit/${SHA}`);
    expect(diff.truncated).toBe(false);
    expect(diff.files).toEqual([
      {
        path: "src/importer.ts",
        previousPath: null,
        status: "added",
        additions: 3,
        deletions: 0,
        patch:
          "@@ -0,0 +1,3 @@\n+export function importRows(rows: string[]) {\n+  return rows.map((row) => row.trim());\n+}",
        truncated: false,
      },
      expect.objectContaining({
        path: "src/app.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
      }),
      expect.objectContaining({
        path: "docs/importing.md",
        previousPath: "docs/import.md",
        status: "renamed",
      }),
      expect.objectContaining({ path: "src/legacy.ts", status: "removed", deletions: 1 }),
      // Binary: no patch, nothing left out.
      expect.objectContaining({ path: "assets/logo.png", patch: null, truncated: false }),
      // Too large for GitHub to show: no patch, truncated.
      expect.objectContaining({ path: "pnpm-lock.yaml", patch: null, truncated: true }),
    ]);
  });

  it("caps the files at maxFiles and each patch at 2,000 lines", async () => {
    const adapter = makeAdapter({ installationId: 42 });
    const long = ["@@ -1,0 +1,2500 @@", ...Array.from({ length: 2_500 }, (_, i) => `+line ${i}`)];
    const files = commit.files.map((file, i) =>
      i === 1 ? { ...file, additions: 2_500, deletions: 0, patch: long.join("\n") } : file,
    );
    server.use(http.get(COMMIT_URL, () => HttpResponse.json({ ...commit, files })));
    const diff = await adapter.getCommitDiff(REPO, SHA, { maxFiles: 2 });
    expect(diff.truncated).toBe(true);
    expect(diff.files.map((f) => f.path)).toEqual(["src/importer.ts", "src/app.ts"]);
    const capped = diff.files[1]!;
    expect(capped.truncated).toBe(true);
    expect(capped.patch?.split("\n")).toHaveLength(MAX_PATCH_LINES);
    expect(capped.additions).toBe(2_500);
  });

  it("is truncated when GitHub has another page of files", async () => {
    const adapter = makeAdapter({ installationId: 42 });
    server.use(
      http.get(COMMIT_URL, () =>
        HttpResponse.json(commit, {
          headers: { link: `<${COMMIT_URL}?per_page=300&page=2>; rel="next"` },
        }),
      ),
    );
    const diff = await adapter.getCommitDiff(REPO, SHA, { maxFiles: 500 });
    expect(diff.files).toHaveLength(commit.files.length);
    expect(diff.truncated).toBe(true);
  });

  it("throws CommitNotFoundError for an unknown commit or repository", async () => {
    const adapter = makeAdapter({ installationId: 42 });
    server.use(
      http.get(COMMIT_URL, () =>
        HttpResponse.json({ message: `No commit found for SHA: ${SHA}` }, { status: 422 }),
      ),
    );
    await expect(adapter.getCommitDiff(REPO, SHA)).rejects.toBeInstanceOf(CommitNotFoundError);
    server.use(
      http.get(COMMIT_URL, () => HttpResponse.json({ message: "Not Found" }, { status: 404 })),
    );
    await expect(adapter.getCommitDiff(REPO, SHA)).rejects.toMatchObject({
      name: "CommitNotFoundError",
      sha: SHA,
    });
    server.use(http.get(COMMIT_URL, () => HttpResponse.json({ message: "boom" }, { status: 500 })));
    await expect(adapter.getCommitDiff(REPO, SHA)).rejects.not.toBeInstanceOf(CommitNotFoundError);
  });
});
