import { notFound, redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AuthorizationError, NO_ORGANIZATION_MESSAGE } from "@/lib/auth/roles";
import type { CurrentUser, OrgUser } from "@/lib/auth/session";
import {
  apiHandler,
  ApiRouteError,
  INTERNAL_ERROR_MESSAGE,
  INVALID_JSON_MESSAGE,
  ORGANIZATION_SWITCHED_MESSAGE,
} from "./handler";
import { ORGANIZATION_HEADER, ORGANIZATION_SWITCHED } from "./schemas";

vi.mock("server-only", () => ({}));

const session = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireSignedInUser: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => session);

const ORG = "11111111-1111-4111-8111-111111111111";
const admin: OrgUser = {
  id: "u1",
  organization: { id: ORG, name: "Acme" },
  role: "admin",
  name: "Ada",
  email: "ada@example.com",
  image: null,
  theme: null,
};

function request(
  init: { method?: string; body?: string; headers?: Record<string, string>; url?: string } = {},
) {
  return new Request(init.url ?? "http://localhost/api/ui/things", {
    method: init.method ?? "GET",
    body: init.body,
    headers: init.headers,
  });
}
const route = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) });

async function json(response: Response) {
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  session.requireUser.mockReset().mockResolvedValue(admin);
  session.requireSignedInUser.mockReset().mockResolvedValue(admin as CurrentUser);
});

describe("apiHandler", () => {
  it("resolves the user with the role and serializes the result", async () => {
    const handler = apiHandler({ access: "admin" }, ({ user, params }) => ({
      org: user.organization.id,
      id: params.id,
    }));
    expect(await json(await handler(request(), route({ id: "h1" })))).toEqual({
      status: 200,
      body: { org: ORG, id: "h1" },
    });
    expect(session.requireUser).toHaveBeenCalledWith("admin");
  });

  it("defaults to members", async () => {
    await apiHandler({}, () => ({}))(request(), route());
    expect(session.requireUser).toHaveBeenCalledWith("member");
  });

  it("answers 401 for signed-out callers", async () => {
    session.requireUser.mockRejectedValue(
      new AuthorizationError("You must be signed in.", "unauthenticated"),
    );
    const fn = vi.fn();
    const result = await json(await apiHandler({}, fn)(request(), route()));
    expect(result).toEqual({
      status: 401,
      body: { error: "You must be signed in.", code: "unauthenticated" },
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("answers 403 without the role or an organization", async () => {
    session.requireUser.mockRejectedValue(
      new AuthorizationError("This action requires the admin role.", "forbidden"),
    );
    const fn = vi.fn();
    expect(await json(await apiHandler({ access: "admin" }, fn)(request(), route()))).toEqual({
      status: 403,
      body: { error: "This action requires the admin role.", code: "forbidden" },
    });
    session.requireUser.mockRejectedValue(
      new AuthorizationError(NO_ORGANIZATION_MESSAGE, "forbidden"),
    );
    expect((await apiHandler({}, fn)(request(), route())).status).toBe(403);
    expect(fn).not.toHaveBeenCalled();
  });

  it("lets signed-in users without an organization through when access is signed-in", async () => {
    session.requireSignedInUser.mockResolvedValue({ ...admin, organization: null, role: null });
    const handler = apiHandler({ access: "signed-in" }, ({ user }) => ({ id: user.id }));
    const response = await handler(
      request({ headers: { [ORGANIZATION_HEADER]: "other" } }),
      route(),
    );
    expect(await json(response)).toEqual({ status: 200, body: { id: "u1" } });
    expect(session.requireUser).not.toHaveBeenCalled();
  });

  it("refuses a request for another organization than the active one with 409", async () => {
    const fn = vi.fn(() => ({}));
    const handler = apiHandler({}, fn);
    const other = await handler(request({ headers: { [ORGANIZATION_HEADER]: "other" } }), route());
    expect(await json(other)).toEqual({
      status: 409,
      body: { error: ORGANIZATION_SWITCHED_MESSAGE, code: ORGANIZATION_SWITCHED },
    });
    expect(fn).not.toHaveBeenCalled();
    const same = await handler(request({ headers: { [ORGANIZATION_HEADER]: ORG } }), route());
    expect(same.status).toBe(200);
  });

  it("validates the JSON body with its schema", async () => {
    const handler = apiHandler(
      { access: "admin", body: z.object({ name: z.string().min(1, "Enter a name.") }) },
      ({ body }) => ({ name: body.name }),
    );
    const ok = await handler(request({ method: "POST", body: '{"name":"x"}' }), route());
    expect(await json(ok)).toEqual({ status: 200, body: { name: "x" } });

    const invalid = await handler(request({ method: "POST", body: '{"name":""}' }), route());
    expect(await json(invalid)).toEqual({
      status: 400,
      body: {
        error: "Enter a name.",
        code: "invalid_request",
        fieldErrors: { name: "Enter a name." },
      },
    });

    const broken = await handler(request({ method: "POST", body: "{nope" }), route());
    expect(await json(broken)).toEqual({
      status: 400,
      body: { error: INVALID_JSON_MESSAGE, code: "invalid_json" },
    });
  });

  it("validates the search params with their schema", async () => {
    const handler = apiHandler(
      { query: z.object({ page: z.coerce.number().int().min(1).default(1) }) },
      ({ query }) => ({ page: query.page }),
    );
    const ok = await handler(request({ url: "http://localhost/api/ui/x?page=3" }), route());
    expect(await json(ok)).toEqual({ status: 200, body: { page: 3 } });
    const bad = await handler(request({ url: "http://localhost/api/ui/x?page=zero" }), route());
    expect(bad.status).toBe(400);
    expect((await bad.json()).fieldErrors).toHaveProperty("page");
  });

  it("maps the shared logic's ActionResult: errors to 400, warnings to 200", async () => {
    const failed = apiHandler({ access: "admin" }, async () => ({
      ok: false as const,
      error: "That slug is taken.",
      fieldErrors: { slug: "That slug is taken." },
    }));
    expect(await json(await failed(request({ method: "POST" }), route()))).toEqual({
      status: 400,
      body: { error: "That slug is taken.", fieldErrors: { slug: "That slug is taken." } },
    });
    const warned = apiHandler({ access: "admin" }, async () => ({
      ok: true as const,
      warning: "Saved, but the webhook couldn't be registered.",
    }));
    expect(await json(await warned(request({ method: "POST" }), route()))).toEqual({
      status: 200,
      body: { ok: true, warning: "Saved, but the webhook couldn't be registered." },
    });
  });

  it("answers 404 for ApiRouteError.notFound() and Next's notFound()", async () => {
    const ours = apiHandler({}, () => {
      throw ApiRouteError.notFound();
    });
    expect(await json(await ours(request(), route()))).toEqual({
      status: 404,
      body: { error: "Not found.", code: "not_found" },
    });
    const next = apiHandler({}, () => notFound());
    expect(await json(await next(request(), route()))).toEqual({
      status: 404,
      body: { error: "Not found.", code: "not_found" },
    });
  });

  it("answers other ApiRouteErrors with their status", async () => {
    const handler = apiHandler({}, () => {
      throw new ApiRouteError(422, "The harness is revoked.", "revoked");
    });
    expect(await json(await handler(request(), route()))).toEqual({
      status: 422,
      body: { error: "The harness is revoked.", code: "revoked" },
    });
  });

  it("answers 500 with a generic message for anything unexpected", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = apiHandler({}, () => {
      throw new Error("connection reset");
    });
    expect(await json(await handler(request(), route()))).toEqual({
      status: 500,
      body: { error: INTERNAL_ERROR_MESSAGE, code: "internal" },
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("leaves Next's redirect() to Next", async () => {
    const handler = apiHandler({}, () => redirect("/elsewhere"));
    await expect(handler(request(), route())).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
  });

  it("returns a Response from the handler as is", async () => {
    const handler = apiHandler({}, () => new Response(null, { status: 204 }));
    expect((await handler(request(), route())).status).toBe(204);
  });
});
