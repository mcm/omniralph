import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GitLabSetupClient, GitLabSetupError } from "./setup.js";

const HOST = "https://gitlab.example.com";
const TOKEN = "glpat-bot";

let queries: URLSearchParams[] = [];

function project(id: number, path: string, visibility: string) {
  return { id, path_with_namespace: path, web_url: `${HOST}/${path}`, visibility };
}

const server = setupServer(
  http.get(`${HOST}/api/v4/projects`, ({ request }) => {
    if (request.headers.get("private-token") !== TOKEN) {
      return HttpResponse.json({ message: "401 Unauthorized" }, { status: 401 });
    }
    const query = new URL(request.url).searchParams;
    queries.push(query);
    const page = Number(query.get("page") ?? 1);
    const pages = [
      [project(2, "acme/web", "private"), project(3, "acme/api", "public")],
      [project(4, "acme/sub/tools", "internal")],
    ];
    return HttpResponse.json(pages[page - 1] ?? [], {
      headers: {
        "x-page": String(page),
        "x-total-pages": String(pages.length),
        ...(page < pages.length
          ? {
              "x-next-page": String(page + 1),
              link: `<${HOST}/api/v4/projects?page=${page + 1}&per_page=100>; rel="next"`,
            }
          : {}),
      },
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  queries = [];
});
afterAll(() => server.close());

describe("GitLabSetupClient.listProjects", () => {
  it("lists every page of unarchived projects the token user maintains, sorted by path", async () => {
    const projects = await new GitLabSetupClient({ baseUrl: HOST, token: TOKEN }).listProjects();

    expect(projects).toEqual([
      { id: 3, fullPath: "acme/api", webUrl: `${HOST}/acme/api`, visibility: "public" },
      { id: 4, fullPath: "acme/sub/tools", webUrl: `${HOST}/acme/sub/tools`, visibility: "internal" },
      { id: 2, fullPath: "acme/web", webUrl: `${HOST}/acme/web`, visibility: "private" },
    ]);
    expect(queries).toHaveLength(2);
    expect(queries[0]!.get("membership")).toBe("true");
    expect(queries[0]!.get("min_access_level")).toBe("40");
    expect(queries[0]!.get("archived")).toBe("false");
  });

  it("reports a rejected token as a setup error", async () => {
    await expect(new GitLabSetupClient({ baseUrl: HOST, token: "nope" }).listProjects()).rejects.toBeInstanceOf(
      GitLabSetupError,
    );
  });
});
