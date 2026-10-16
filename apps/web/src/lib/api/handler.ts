import "server-only";
import { fieldErrors } from "@omniralph/shared";
import { unstable_rethrow } from "next/navigation";
import { NextResponse } from "next/server";
import type { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { AuthorizationError, type Role } from "@/lib/auth/roles";
import {
  requireSignedInUser,
  requireUser,
  type CurrentUser,
  type OrgUser,
} from "@/lib/auth/session";
import { ORGANIZATION_HEADER, ORGANIZATION_SWITCHED, type ApiErrorBody } from "./schemas";

/** Shown when another tab switched organizations since this one loaded its data. */
export const ORGANIZATION_SWITCHED_MESSAGE =
  "You switched organizations in another tab. Continue from the dashboard.";
export const INVALID_JSON_MESSAGE = "The request body isn't valid JSON.";
export const NOT_FOUND_MESSAGE = "Not found.";
export const INTERNAL_ERROR_MESSAGE = "Something went wrong. Try again.";

/**
 * Thrown by a handler to answer with an error status and message, e.g.
 * `throw ApiRouteError.notFound()` for a resource outside the active organization.
 */
export class ApiRouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly fieldErrors?: Record<string, string>,
    readonly enterPath?: string,
  ) {
    super(message);
    this.name = "ApiRouteError";
  }

  static notFound(message = NOT_FOUND_MESSAGE) {
    return new ApiRouteError(404, message, "not_found");
  }
}

/** A JSON error response in the shape `apiRequest` reads (`apiErrorBodySchema`). */
export function apiError(status: number, body: ApiErrorBody): NextResponse<ApiErrorBody> {
  return NextResponse.json(body, { status });
}

/** Who may call the handler: members or admins of the active organization, or any signed-in user. */
type Access = Role | "signed-in";
type UserFor<A extends Access> = A extends Role ? OrgUser : CurrentUser;

type Params = Record<string, string | string[] | undefined>;

export interface ApiContext<A extends Access, B, Q, P extends Params> {
  request: Request;
  user: UserFor<A>;
  /** The parsed body (`body` schema), else `undefined`. */
  body: B;
  /** The parsed search params (`query` schema), else `undefined`. */
  query: Q;
  /** The route's dynamic segments. */
  params: P;
}

export interface ApiHandlerOptions<A extends Access, BS, QS> {
  /** Default `member`. */
  access?: A;
  /** Validates the JSON body; a mismatch answers 400 with `fieldErrors`. */
  body?: BS;
  /** Validates the search params (single values as strings); a mismatch answers 400. */
  query?: QS;
}

type Infer<S> = S extends z.ZodType ? z.infer<S> : undefined;

/**
 * What a handler may return: a `Response` as is, an `ActionResult` (the result of the
 * logic shared with the server actions: `{ ok: false }` answers 400 with its error and
 * field errors, `{ ok: true }` 200), or any other JSON body (200).
 */
type HandlerResult = Response | ActionResult | object;

/**
 * Builds an `/api/ui` route handler. It resolves the signed-in user with the session
 * helpers (`requireUser(access)`), refuses a request for an organization other than the
 * active one (`ORGANIZATION_HEADER`, sent by `apiRequest`), validates the body and search
 * params with the shared zod schemas, runs `fn`, and serializes its result. Every failure
 * is JSON in one shape (`{ error, code?, fieldErrors? }`):
 *
 * - 401 signed out, 403 without the role or an organization (`AuthorizationError`);
 * - 409 `organization_switched` when the active organization changed in another tab;
 * - 400 invalid JSON, a body or query that doesn't match its schema, or a failed `ActionResult`;
 * - 404 `ApiRouteError.notFound()` (or Next's `notFound()`);
 * - any other `ApiRouteError` with its status, and 500 for anything unexpected.
 *
 * Handlers scope every query to `user.organization.id`.
 */
export function apiHandler<
  A extends Access = "member",
  BS extends z.ZodType | undefined = undefined,
  QS extends z.ZodType | undefined = undefined,
  P extends Params = Params,
>(
  options: ApiHandlerOptions<A, BS, QS>,
  fn: (context: ApiContext<A, Infer<BS>, Infer<QS>, P>) => Promise<HandlerResult> | HandlerResult,
): (request: Request, route: { params: Promise<P> }) => Promise<Response> {
  const access = (options.access ?? "member") as Access;
  return async (request, route) => {
    try {
      const user = access === "signed-in" ? await requireSignedInUser() : await requireUser(access);
      const expected = request.headers.get(ORGANIZATION_HEADER);
      if (access !== "signed-in" && expected && expected !== user.organization?.id) {
        return apiError(409, { error: ORGANIZATION_SWITCHED_MESSAGE, code: ORGANIZATION_SWITCHED });
      }

      let body: unknown;
      if (options.body) {
        let json: unknown;
        try {
          json = await request.json();
        } catch {
          return apiError(400, { error: INVALID_JSON_MESSAGE, code: "invalid_json" });
        }
        const parsed = options.body.safeParse(json);
        if (!parsed.success) return invalid(parsed.error);
        body = parsed.data;
      }

      let query: unknown;
      if (options.query) {
        const search = Object.fromEntries(new URL(request.url).searchParams);
        const parsed = options.query.safeParse(search);
        if (!parsed.success) return invalid(parsed.error);
        query = parsed.data;
      }

      const params = ((await route?.params) ?? {}) as P;
      const result = await fn({
        request,
        user: user as UserFor<A>,
        body: body as Infer<BS>,
        query: query as Infer<QS>,
        params,
      });
      return toResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

function invalid(error: z.ZodError): NextResponse<ApiErrorBody> {
  const errors = fieldErrors(error);
  return apiError(400, {
    error: Object.values(errors)[0] ?? "The request is invalid.",
    code: "invalid_request",
    fieldErrors: errors,
  });
}

function isActionResult(value: object): value is ActionResult {
  return "ok" in value && typeof value.ok === "boolean";
}

function toResponse(result: HandlerResult): Response {
  if (result instanceof Response) return result;
  if (isActionResult(result) && !result.ok) {
    return apiError(400, {
      error: result.error,
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
    });
  }
  return NextResponse.json(result);
}

/** Next's `notFound()` throws an error with this digest. */
const NEXT_NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";

function errorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return apiError(error.reason === "unauthenticated" ? 401 : 403, {
      error: error.message,
      code: error.reason,
    });
  }
  if (error instanceof ApiRouteError) {
    return apiError(error.status, {
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      ...(error.enterPath ? { enterPath: error.enterPath } : {}),
    });
  }
  if (
    error instanceof Error &&
    (error as Error & { digest?: unknown }).digest === NEXT_NOT_FOUND_DIGEST
  ) {
    return apiError(404, { error: NOT_FOUND_MESSAGE, code: "not_found" });
  }
  // Next's own control flow (redirect(), dynamic rendering bail-outs) goes back to Next.
  unstable_rethrow(error);
  console.error("[api/ui]", error);
  return apiError(500, { error: INTERNAL_ERROR_MESSAGE, code: "internal" });
}
