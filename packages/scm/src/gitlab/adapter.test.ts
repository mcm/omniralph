import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryCredentialCache } from "../credential-cache.js";
import { GitLabAdapter } from "./adapter.js";

const HOST = "https://gitlab.example.com";
const API = `${HOST}/api/v4/projects/99`;
const MR = `${API}/merge_requests/7`;
const REPO = { fullPath: "acme/tools/widgets", externalId: "99" };
const BASE = "b".repeat(40);
const START = "s".repeat(40);
const HEAD = "h".repeat(40);
const TOKEN = "glpat-bot";
const SECRET = "hook-secret";

let now = Date.UTC(2026, 9, 4, 12, 0, 0);
let requests: { method: string; url: string; auth: string | null; body: unknown }[] = [];
let tokensIssued = 0;

async function readBody(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries((await request.formData()).entries());
  }
  const text = await request.text();
  return text ? JSON.parse(text) : null;
}

const mrJson = {
  iid: 7,
  title: "Add widgets",
  description: null,
  author: { username: "alice" },
  draft: true,
  diff_refs: { base_sha: BASE, start_sha: START, head_sha: HEAD },
  sha: HEAD,
  source_branch: "feature",
  target_branch: "main",
  web_url: `${HOST}/acme/tools/widgets/-/merge_requests/7`,
};

const diffs = [
  {
    old_path: "src/app.ts",
    new_path: "src/app.ts",
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    diff: "@@ -10,3 +10,4 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n const d = 5;\n",
  },
];

let discussionCount = 0;

const server = setupServer(
  http.get(MR, () => HttpResponse.json(mrJson)),
  http.get(`${MR}/diffs`, () => HttpResponse.json(diffs)),
  http.post(`${MR}/discussions`, () => {
    discussionCount += 1;
    return HttpResponse.json(
      { id: String(discussionCount).padStart(40, "d"), notes: [{ id: 500 + discussionCount }] },
      { status: 201 },
    );
  }),
  http.post(`${MR}/notes`, () => HttpResponse.json({ id: 900 }, { status: 201 })),
  http.post(`${API}/access_tokens`, async ({ request }) => {
    const body = (await request.clone().json()) as {
      name: string;
      expires_at: string;
      scopes: string[];
      access_level: number;
    };
    tokensIssued += 1;
    const kind = body.scopes.includes("write_repository") ? "write" : "read";
    return HttpResponse.json(
      {
        id: 300 + tokensIssued,
        name: body.name,
        token: `glpat-${kind}-${tokensIssued}`,
        expires_at: body.expires_at,
        scopes: body.scopes,
        access_level: body.access_level,
      },
      { status: 201 },
    );
  }),
);

let pendingBodies: Promise<void>[] = [];
server.events.on("request:start", ({ request }) => {
  const record: (typeof requests)[number] = {
    method: request.method,
    url: request.url,
    auth: request.headers.get("private-token"),
    body: null,
  };
  requests.push(record);
  if (request.method !== "GET") {
    pendingBodies.push(readBody(request.clone()).then((body) => void (record.body = body)));
  }
});

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => {
  now = Date.UTC(2026, 9, 4, 12, 0, 0);
  requests = [];
  pendingBodies = [];
  tokensIssued = 0;
  discussionCount = 0;
});

function makeAdapter(cache = new MemoryCredentialCache()) {
  return new GitLabAdapter({
    token: TOKEN,
    webhookSecret: SECRET,
    baseUrl: `${HOST}/`,
    credentialCache: cache,
    now: () => now,
  });
}

async function posts(suffix: string) {
  await Promise.all(pendingBodies);
  return requests.filter((r) => r.method === "POST" && r.url.endsWith(suffix));
}

describe("getChangeRequest", () => {
  it("maps MR fields, draft and diff_refs, authenticating as the bot token", async () => {
    const cr = await makeAdapter().getChangeRequest(REPO, 7);
    expect(cr).toEqual({
      number: 7,
      title: "Add widgets",
      description: "",
      author: "alice",
      draft: true,
      state: "open",
      baseSha: BASE,
      startSha: START,
      headSha: HEAD,
      baseRef: "main",
      headRef: "feature",
      url: `${HOST}/acme/tools/widgets/-/merge_requests/7`,
    });
    expect(requests[0]?.auth).toBe(TOKEN);
  });

  it("falls back to work_in_progress and URL-encodes the path without a project ID", async () => {
    server.use(
      http.get(`${HOST}/api/v4/projects/acme%2Ftools%2Fwidgets/merge_requests/7`, () =>
        HttpResponse.json({ ...mrJson, draft: undefined, work_in_progress: false }),
      ),
    );
    const cr = await makeAdapter().getChangeRequest({ fullPath: "acme/tools/widgets" }, 7);
    expect(cr.draft).toBe(false);
  });

  it("maps the MR state", async () => {
    for (const [state, expected] of [
      ["opened", "open"],
      ["locked", "open"],
      ["closed", "closed"],
      ["merged", "merged"],
    ] as const) {
      server.use(http.get(MR, () => HttpResponse.json({ ...mrJson, state })));
      expect((await makeAdapter().getChangeRequest(REPO, 7)).state).toBe(expected);
    }
  });

  it("fails clearly while the MR diff isn't ready", async () => {
    server.use(http.get(MR, () => HttpResponse.json({ ...mrJson, diff_refs: null })));
    await expect(makeAdapter().getChangeRequest(REPO, 7)).rejects.toThrow(/no diff yet/);
  });
});

describe("postReview", () => {
  it("creates one discussion per inline comment with a text position, then the summary note", async () => {
    const posted = await makeAdapter().postReview(REPO, 7, {
      summary: "## Summary",
      inlineComments: [
        { path: "src/app.ts", line: 11, body: "Use a constant", suggestion: "const b = B;" },
        { path: "src/app.ts", line: 11, side: "old", body: "Why remove this?" },
        { path: "src/app.ts", line: 13, body: "Context line" },
      ],
    });

    const discussions = await posts("/merge_requests/7/discussions");
    expect(discussions).toHaveLength(3);
    expect(discussions[0]?.body).toEqual({
      body: "Use a constant\n\n```suggestion:-0+0\nconst b = B;\n```",
      position: {
        position_type: "text",
        base_sha: BASE,
        start_sha: START,
        head_sha: HEAD,
        old_path: "src/app.ts",
        new_path: "src/app.ts",
        new_line: 11,
      },
    });
    expect(discussions[1]?.body).toMatchObject({ position: { old_line: 11 } });
    expect(discussions[1]?.body).not.toHaveProperty("position.new_line");
    expect(discussions[2]?.body).toMatchObject({ position: { old_line: 12, new_line: 13 } });

    // The summary is a single note, posted after the discussions.
    const notes = await posts("/merge_requests/7/notes");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toEqual({ body: "## Summary" });
    expect(requests.at(-1)?.url).toBe(`${MR}/notes`);

    expect(posted).toEqual({
      reviewId: "900",
      summaryCommentId: "900",
      inlineCommentIds: ["d".repeat(39) + "1", "d".repeat(39) + "2", "d".repeat(39) + "3"],
    });
  });

  it("sends a line_range and a multi-line suggestion for ranges", async () => {
    await makeAdapter().postReview(REPO, 7, {
      summary: "s",
      inlineComments: [{ path: "src/app.ts", startLine: 11, line: 12, body: "b", suggestion: "x\ny" }],
    });
    expect((await posts("/discussions"))[0]?.body).toMatchObject({
      body: "b\n\n```suggestion:-1+0\nx\ny\n```",
      position: {
        new_line: 12,
        line_range: {
          start: { line_code: expect.stringMatching(/^[0-9a-f]{40}_12_11$/), type: "new", new_line: 11 },
          end: { line_code: expect.stringMatching(/^[0-9a-f]{40}_12_12$/), type: "new", new_line: 12 },
        },
      },
    });
  });

  it("falls back to the summary note for comments outside the diff or rejected positions", async () => {
    let calls = 0;
    server.use(
      http.post(`${MR}/discussions`, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json({ message: "400 Bad request - Note {:line_code=>[\"can't be blank\"]}" }, { status: 400 });
        }
        return HttpResponse.json({ id: "e".repeat(40), notes: [{ id: 1 }] }, { status: 201 });
      }),
    );
    const posted = await makeAdapter().postReview(REPO, 7, {
      summary: "## Summary",
      inlineComments: [
        { path: "src/app.ts", line: 11, body: "Rejected by GitLab" },
        { path: "src/other.ts", line: 3, body: "Not in diff", suggestion: "fix()" },
        { path: "src/app.ts", line: 12, body: "Fine" },
      ],
    });

    expect(await posts("/discussions")).toHaveLength(2);
    expect(posted.inlineCommentIds).toEqual([null, null, "e".repeat(40)]);
    const summary = ((await posts("/notes"))[0]?.body as { body: string }).body;
    expect(summary).toContain("### Comments outside the diff");
    expect(summary).toContain("**`src/app.ts`** L11\n\nRejected by GitLab");
    expect(summary).toContain("**`src/other.ts`** L3\n\nNot in diff\n\n```\nfix()\n```");
    expect(summary).not.toContain("suggestion");
  });

  it("propagates other API errors", async () => {
    server.use(http.post(`${MR}/discussions`, () => HttpResponse.json({ message: "nope" }, { status: 403 })));
    await expect(
      makeAdapter().postReview(REPO, 7, {
        summary: "s",
        inlineComments: [{ path: "src/app.ts", line: 11, body: "x" }],
      }),
    ).rejects.toThrow();
    expect(await posts("/notes")).toHaveLength(0);
  });

  it("anchors to the matching diff version when reviewing an older commit", async () => {
    const OLD_HEAD = "o".repeat(40);
    server.use(
      http.get(`${MR}/versions`, () =>
        HttpResponse.json([
          { id: 2, head_commit_sha: HEAD, base_commit_sha: BASE, start_commit_sha: START },
          { id: 1, head_commit_sha: OLD_HEAD, base_commit_sha: BASE, start_commit_sha: "t".repeat(40) },
        ]),
      ),
      http.get(`${MR}/versions/1`, () =>
        HttpResponse.json({
          id: 1,
          head_commit_sha: OLD_HEAD,
          base_commit_sha: BASE,
          start_commit_sha: "t".repeat(40),
          diffs: [{ old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-x\n+y\n" }],
        }),
      ),
    );
    await makeAdapter().postReview(REPO, 7, {
      summary: "s",
      commitSha: OLD_HEAD,
      inlineComments: [{ path: "a.ts", line: 1, body: "x" }],
    });
    expect((await posts("/discussions"))[0]?.body).toMatchObject({
      position: { head_sha: OLD_HEAD, start_sha: "t".repeat(40), base_sha: BASE, new_line: 1 },
    });
  });

  it("falls back entirely when the reviewed commit is no longer a diff version", async () => {
    server.use(http.get(`${MR}/versions`, () => HttpResponse.json([])));
    const posted = await makeAdapter().postReview(REPO, 7, {
      summary: "s",
      commitSha: "f".repeat(40),
      inlineComments: [{ path: "src/app.ts", line: 11, body: "x" }],
    });
    expect(await posts("/discussions")).toHaveLength(0);
    expect(posted.inlineCommentIds).toEqual([null]);
  });
});

describe("threads", () => {
  const DISCUSSION = "a1".repeat(20);

  it("resolves a discussion by ID", async () => {
    server.use(
      http.put(`${MR}/discussions/${DISCUSSION}`, () => HttpResponse.json({ id: DISCUSSION, notes: [] })),
    );
    await makeAdapter().resolveThread(REPO, 7, DISCUSSION);
    await Promise.all(pendingBodies);
    const put = requests.find((r) => r.method === "PUT");
    expect(put?.url).toBe(`${MR}/discussions/${DISCUSSION}?resolved=true`);
  });

  it("finds the discussion of a note ID before resolving", async () => {
    server.use(
      http.get(`${MR}/discussions`, () =>
        HttpResponse.json([
          { id: "c".repeat(40), notes: [{ id: 1 }] },
          { id: DISCUSSION, notes: [{ id: 2 }, { id: 3 }] },
        ]),
      ),
      http.put(`${MR}/discussions/${DISCUSSION}`, () => HttpResponse.json({ id: DISCUSSION, notes: [] })),
    );
    await makeAdapter().resolveThread(REPO, 7, "3");
    expect(requests.some((r) => r.method === "PUT" && r.url.includes(DISCUSSION))).toBe(true);
  });

  it("posts a top-level MR note", async () => {
    server.use(http.post(`${MR}/notes`, () => HttpResponse.json({ id: 78 }, { status: 201 })));
    await expect(makeAdapter().postComment(REPO, 7, "Hello")).resolves.toEqual({ id: "78" });
    expect((await posts(`/merge_requests/7/notes`))[0]?.body).toEqual({ body: "Hello" });
  });

  it("replies in the discussion", async () => {
    server.use(
      http.post(`${MR}/discussions/${DISCUSSION}/notes`, () => HttpResponse.json({ id: 77 }, { status: 201 })),
    );
    await expect(makeAdapter().replyToComment(REPO, 7, DISCUSSION, "Thanks")).resolves.toEqual({ id: "77" });
    expect((await posts(`/discussions/${DISCUSSION}/notes`))[0]?.body).toEqual({ body: "Thanks" });
  });
});

describe("getReadOnlyCloneCredential", () => {
  it("creates a read_repository Reporter token expiring the next day and caches it", async () => {
    const cache = new MemoryCredentialCache();
    const adapter = makeAdapter(cache);
    const credential = await adapter.getReadOnlyCloneCredential(REPO);

    const created = await posts("/projects/99/access_tokens");
    expect(created).toHaveLength(1);
    expect(created[0]?.body).toEqual({
      name: "omniralph-read-repository",
      scopes: ["read_repository"],
      expires_at: "2026-10-05",
      access_level: 20,
    });
    expect(credential).toEqual({
      cloneUrl: `${HOST}/acme/tools/widgets.git`,
      username: "oauth2",
      token: "glpat-read-1",
      expiresAt: new Date("2026-10-05T00:00:00Z"),
    });
    expect(await cache.get(REPO, "read_repository")).toEqual({
      token: "glpat-read-1",
      expiresAt: new Date("2026-10-05T00:00:00Z"),
      externalId: "301",
    });

    // Reused, also by another adapter sharing the cache (another instance).
    now = Date.UTC(2026, 9, 4, 21, 59, 0);
    await expect(makeAdapter(cache).getReadOnlyCloneCredential(REPO)).resolves.toMatchObject({
      token: "glpat-read-1",
    });
    expect(await posts("/access_tokens")).toHaveLength(1);
  });

  it("rotates the token once it's within 2 hours of expiry", async () => {
    const cache = new MemoryCredentialCache();
    const adapter = makeAdapter(cache);
    await adapter.getReadOnlyCloneCredential(REPO);

    now = Date.UTC(2026, 9, 4, 22, 0, 0);
    const rotated = await adapter.getReadOnlyCloneCredential(REPO);
    expect(rotated.token).toBe("glpat-read-2");
    // Tomorrow would be inside the rotation window, so the new token gets the day after.
    expect(((await posts("/access_tokens"))[1]?.body as { expires_at: string }).expires_at).toBe("2026-10-06");
    expect(rotated.expiresAt).toEqual(new Date("2026-10-06T00:00:00Z"));
    expect((await cache.get(REPO, "read_repository"))?.externalId).toBe("302");
  });

  it("deduplicates concurrent creation and doesn't cache failures", async () => {
    const adapter = makeAdapter();
    await Promise.all([adapter.getReadOnlyCloneCredential(REPO), adapter.getReadOnlyCloneCredential(REPO)]);
    expect(await posts("/access_tokens")).toHaveLength(1);

    const failing = makeAdapter();
    server.use(
      http.post(`${API}/access_tokens`, () => HttpResponse.json({ message: "403 Forbidden" }, { status: 403 }), {
        once: true,
      }),
    );
    await expect(failing.getReadOnlyCloneCredential(REPO)).rejects.toThrow();
    await expect(failing.getReadOnlyCloneCredential(REPO)).resolves.toMatchObject({ token: "glpat-read-2" });
  });
});

describe("getWriteCloneCredential", () => {
  it("creates a write_repository Developer token cached under its own scope", async () => {
    const cache = new MemoryCredentialCache();
    const adapter = makeAdapter(cache);
    const read = await adapter.getReadOnlyCloneCredential(REPO);
    const credential = await adapter.getWriteCloneCredential(REPO);

    const created = await posts("/projects/99/access_tokens");
    expect(created).toHaveLength(2);
    expect(created[1]?.body).toEqual({
      name: "omniralph-write-repository",
      scopes: ["write_repository"],
      expires_at: "2026-10-05",
      access_level: 30,
    });
    expect(credential).toEqual({
      cloneUrl: `${HOST}/acme/tools/widgets.git`,
      username: "oauth2",
      token: "glpat-write-2",
      expiresAt: new Date("2026-10-05T00:00:00Z"),
    });
    expect(read.token).toBe("glpat-read-1");
    expect(await cache.get(REPO, "write_repository")).toEqual({
      token: "glpat-write-2",
      expiresAt: new Date("2026-10-05T00:00:00Z"),
      externalId: "302",
    });
    expect((await cache.get(REPO, "read_repository"))?.token).toBe("glpat-read-1");

    // Reused from the cache, then rotated within 2 hours of expiry.
    await expect(makeAdapter(cache).getWriteCloneCredential(REPO)).resolves.toMatchObject({
      token: "glpat-write-2",
    });
    expect(await posts("/access_tokens")).toHaveLength(2);
    now = Date.UTC(2026, 9, 4, 22, 0, 0);
    const rotated = await adapter.getWriteCloneCredential(REPO);
    expect(rotated.token).toBe("glpat-write-3");
    expect(rotated.expiresAt).toEqual(new Date("2026-10-06T00:00:00Z"));
    expect((await cache.get(REPO, "write_repository"))?.externalId).toBe("303");
  });

  it("doesn't share in-flight creation with the read-only token", async () => {
    const adapter = makeAdapter();
    const [read, write] = await Promise.all([
      adapter.getReadOnlyCloneCredential(REPO),
      adapter.getWriteCloneCredential(REPO),
    ]);
    expect(read.token).toMatch(/^glpat-read-/);
    expect(write.token).toMatch(/^glpat-write-/);
  });
});

describe("hasWriteAccess", () => {
  it("requires Developer access or higher, including inherited membership", async () => {
    server.use(
      http.get(`${HOST}/api/v4/users`, ({ request }) => {
        const username = new URL(request.url).searchParams.get("username");
        return HttpResponse.json(username === "ghost" ? [] : [{ id: username === "dev" ? 1 : 2, username }]);
      }),
      http.get(`${API}/members/all/1`, () => HttpResponse.json({ id: 1, access_level: 30 })),
      http.get(`${API}/members/all/2`, () => HttpResponse.json({ id: 2, access_level: 20 })),
    );
    const adapter = makeAdapter();
    await expect(adapter.hasWriteAccess(REPO, "dev")).resolves.toBe(true);
    await expect(adapter.hasWriteAccess(REPO, "reporter")).resolves.toBe(false);
    await expect(adapter.hasWriteAccess(REPO, "ghost")).resolves.toBe(false);
  });

  it("treats non-members as having no access", async () => {
    server.use(
      http.get(`${HOST}/api/v4/users`, () => HttpResponse.json([{ id: 5, username: "outsider" }])),
      http.get(`${API}/members/all/5`, () => HttpResponse.json({ message: "404 Not found" }, { status: 404 })),
    );
    await expect(makeAdapter().hasWriteAccess(REPO, "outsider")).resolves.toBe(false);
  });
});

describe("verifyWebhook", () => {
  it("accepts only the configured X-Gitlab-Token", async () => {
    const adapter = makeAdapter();
    await expect(adapter.verifyWebhook(new Headers({ "X-Gitlab-Token": SECRET }), "{}")).resolves.toBe(true);
    await expect(adapter.verifyWebhook({ "x-gitlab-token": SECRET }, "{}")).resolves.toBe(true);
    await expect(adapter.verifyWebhook({ "x-gitlab-token": "wrong" }, "{}")).resolves.toBe(false);
    await expect(adapter.verifyWebhook({ "x-gitlab-token": `${SECRET}x` }, "{}")).resolves.toBe(false);
    await expect(adapter.verifyWebhook({}, "{}")).resolves.toBe(false);
  });

  it("rejects everything when no secret is configured", async () => {
    const adapter = new GitLabAdapter({ token: TOKEN, webhookSecret: "" });
    await expect(adapter.verifyWebhook({ "x-gitlab-token": "" }, "{}")).resolves.toBe(false);
  });
});
