import type { z } from "zod";
import { apiErrorBodySchema, ORGANIZATION_HEADER } from "./schemas";

/** Shown when a response isn't the JSON the panel expects (a proxy error page, a deploy mid-flight). */
export const UNEXPECTED_RESPONSE = "The server sent an unexpected response. Try again.";
/** Shown when the request never got an answer. */
export const NETWORK_ERROR = "Couldn't reach the server. Check your connection and try again.";

/**
 * A failed `/api/ui` request. `message` is what the UI shows: the server's own message
 * (same wording as the server actions' errors) when it sent one.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP status; `0` when there was no response. */
    readonly status: number,
    /** The server's machine-readable reason, e.g. `organization_switched`. */
    readonly code?: string,
    /** Form validation errors by field path, shown inline. */
    readonly fieldErrors?: Record<string, string>,
    /** With `code: ENTER_ORGANIZATION`: the path that switches to the resource's organization. */
    readonly enterPath?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Sent as JSON. */
  body?: unknown;
  /** Query string values; `undefined` and `null` are left out, lists repeat their key. */
  params?: Record<string, string | number | boolean | readonly string[] | null | undefined>;
  /**
   * The organization the caller's cache is for (the first element of its query key): the
   * handler refuses the request when another tab has switched the active one.
   */
  organizationId?: string;
  /** Aborts the request (TanStack Query passes one to every `queryFn`). */
  signal?: AbortSignal;
}

function withParams(path: string, params: ApiRequestOptions["params"]): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (Array.isArray(value)) for (const item of value) query.append(key, item);
    else if (value !== undefined && value !== null) query.set(key, String(value));
  }
  return query.size > 0 ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path;
}

/**
 * Calls an `/api/ui` route handler and parses its JSON response with `schema` (shared
 * with the handler). Throws `ApiError` on a non-2xx response (with the server's message),
 * on a response that isn't the expected JSON, and when the request fails.
 */
export async function apiRequest<S extends z.ZodType>(
  path: string,
  schema: S,
  { method = "GET", body, params, organizationId, signal }: ApiRequestOptions = {},
): Promise<z.infer<S>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (organizationId) headers[ORGANIZATION_HEADER] = organizationId;
  let response: Response;
  try {
    response = await fetch(withParams(path, params), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: "same-origin",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(NETWORK_ERROR, 0);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ApiError(UNEXPECTED_RESPONSE, response.status);
  }
  if (!response.ok) {
    const parsed = apiErrorBodySchema.safeParse(json);
    if (!parsed.success) throw new ApiError(UNEXPECTED_RESPONSE, response.status);
    const { error, code, fieldErrors, enterPath } = parsed.data;
    throw new ApiError(error, response.status, code, fieldErrors, enterPath);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError(UNEXPECTED_RESPONSE, response.status);
  return parsed.data;
}

/** `apiRequest` by method. */
export const api = {
  get: <S extends z.ZodType>(
    path: string,
    schema: S,
    options?: Omit<ApiRequestOptions, "method" | "body">,
  ) => apiRequest(path, schema, { ...options, method: "GET" }),
  post: <S extends z.ZodType>(
    path: string,
    schema: S,
    options?: Omit<ApiRequestOptions, "method">,
  ) => apiRequest(path, schema, { ...options, method: "POST" }),
  patch: <S extends z.ZodType>(
    path: string,
    schema: S,
    options?: Omit<ApiRequestOptions, "method">,
  ) => apiRequest(path, schema, { ...options, method: "PATCH" }),
  put: <S extends z.ZodType>(
    path: string,
    schema: S,
    options?: Omit<ApiRequestOptions, "method">,
  ) => apiRequest(path, schema, { ...options, method: "PUT" }),
  delete: <S extends z.ZodType>(
    path: string,
    schema: S,
    options?: Omit<ApiRequestOptions, "method">,
  ) => apiRequest(path, schema, { ...options, method: "DELETE" }),
};
