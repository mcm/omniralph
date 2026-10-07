import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkGitLabConnection, type GitLabHealthProject } from "./health.js";

const HOST = "https://gitlab.example.com";
const TOKEN = "glpat-bot";
const NOW = new Date("2026-10-07T12:00:00Z");

/** Mutable GitLab state the handlers serve. */
let user: { status: number; username: string };
let token: { status: number; scopes: string[]; expires_at: string | null };
let hooks: Map<string, Record<string, unknown>>;
let requests: string[];

const goodHook = {
  merge_requests_events: true,
  note_events: true,
  pipeline_events: true,
  enable_ssl_verification: true,
};

const server = setupServer(
  http.all(`${HOST}/*`, ({ request }) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
  }),
  http.get(`${HOST}/api/v4/user`, () =>
    user.status === 200
      ? HttpResponse.json({ id: 42, username: user.username, name: "Omniralph" })
      : HttpResponse.json({ message: "401 Unauthorized" }, { status: user.status }),
  ),
  http.get(`${HOST}/api/v4/personal_access_tokens/self`, () =>
    token.status === 200
      ? HttpResponse.json({ id: 7, scopes: token.scopes, expires_at: token.expires_at })
      : HttpResponse.json({ message: "404 Not Found" }, { status: token.status }),
  ),
  http.get(`${HOST}/api/v4/projects/:projectId/hooks/:hookId`, ({ params }) => {
    const hook = hooks.get(`${String(params.projectId)}/${String(params.hookId)}`);
    return hook
      ? HttpResponse.json({
          id: Number(params.hookId),
          url: "https://omniralph.example.com",
          ...hook,
        })
      : HttpResponse.json({ message: "404 Not Found" }, { status: 404 });
  }),
);

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
beforeEach(() => {
  user = { status: 200, username: "service_account_group_12_omniralph" };
  token = { status: 200, scopes: ["api"], expires_at: "2026-10-14" };
  hooks = new Map([["10/100", goodHook]]);
  requests = [];
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const web: GitLabHealthProject = {
  repositoryId: "repo-web",
  projectId: "10",
  fullPath: "acme/web",
  webhookId: "100",
};

const check = (projects: GitLabHealthProject[] = [web]) =>
  checkGitLabConnection({ baseUrl: HOST, token: TOKEN, projects, now: NOW });

describe("checkGitLabConnection", () => {
  it("reports no problems for a healthy connection", async () => {
    expect(await check()).toEqual({
      checkedAt: NOW.toISOString(),
      tokenExpiresAt: "2026-10-14",
      problems: [],
    });
  });

  it("only reads from GitLab, never changing a webhook", async () => {
    hooks.set("10/100", { ...goodHook, pipeline_events: false });
    await check([web, { ...web, repositoryId: "repo-api", projectId: "11", webhookId: "101" }]);
    expect(requests.every((r) => r.startsWith("GET "))).toBe(true);
  });

  it("reports a rejected token as token_invalid and checks nothing else", async () => {
    user.status = 401;
    const health = await check();
    expect(health.problems).toEqual([
      { code: "token_invalid", message: expect.stringContaining("rejects") },
    ]);
    expect(requests).toEqual(["GET /api/v4/user"]);
  });

  it("reports a token without the api scope as missing_api_scope", async () => {
    token.scopes = ["read_api", "write_repository"];
    const health = await check();
    expect(health.problems).toEqual([
      {
        code: "missing_api_scope",
        message: "The bot token needs the api scope (it has: read_api, write_repository).",
      },
    ]);
  });

  it("reports a group or project access token's bot user as access_token_bot", async () => {
    user.username = "project_10_bot_0123abcd";
    const health = await check();
    expect(health.problems.map((p) => p.code)).toEqual(["access_token_bot"]);
    expect(health.problems[0]!.message).toContain("service account");
  });

  it("reports a token expiring within 3 days as token_expiring", async () => {
    token.expires_at = "2026-10-10";
    expect((await check()).problems).toEqual([
      { code: "token_expiring", message: "The bot token expires on 2026-10-10." },
    ]);
    token.expires_at = "2026-10-11";
    expect((await check()).problems).toEqual([]);
  });

  it("keeps going without an expiry on instances without /personal_access_tokens/self", async () => {
    token.status = 404;
    expect(await check()).toMatchObject({ tokenExpiresAt: null, problems: [] });
  });

  it("reports a project without a stored webhook or whose webhook is gone as webhook_missing", async () => {
    const health = await check([
      { ...web, repositoryId: "repo-none", webhookId: null },
      { ...web, repositoryId: "repo-gone", webhookId: "999" },
      { ...web, repositoryId: "repo-no-project", projectId: "404" },
    ]);
    expect(health.problems).toEqual([
      expect.objectContaining({ code: "webhook_missing", repositoryId: "repo-none" }),
      expect.objectContaining({ code: "webhook_missing", repositoryId: "repo-gone" }),
      expect.objectContaining({ code: "webhook_missing", repositoryId: "repo-no-project" }),
    ]);
  });

  it("reports a webhook lacking events or SSL verification as webhook_events_outdated", async () => {
    hooks.set("10/100", { ...goodHook, note_events: false, enable_ssl_verification: false });
    hooks.set("11/101", { ...goodHook, pipeline_events: false });
    hooks.set("12/102", { ...goodHook, merge_requests_events: false });
    const health = await check([
      web,
      { ...web, repositoryId: "repo-api", projectId: "11", fullPath: "acme/api", webhookId: "101" },
      {
        ...web,
        repositoryId: "repo-docs",
        projectId: "12",
        fullPath: "acme/docs",
        webhookId: "102",
      },
    ]);
    expect(health.problems).toEqual([
      {
        code: "webhook_events_outdated",
        message: "The webhook of acme/web lacks comment events, SSL verification.",
        repositoryId: "repo-web",
      },
      {
        code: "webhook_events_outdated",
        message: "The webhook of acme/api lacks pipeline events.",
        repositoryId: "repo-api",
      },
      {
        code: "webhook_events_outdated",
        message: "The webhook of acme/docs lacks merge request events.",
        repositoryId: "repo-docs",
      },
    ]);
  });

  it("throws when GitLab fails otherwise", async () => {
    user.status = 500;
    await expect(check()).rejects.toThrow();
  });
});
