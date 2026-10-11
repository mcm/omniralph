import {
  EnrollResponse,
  HeartbeatResponse,
  JobOutcomeResponse,
  JobStartResponse,
  MAX_CLAIM_WAIT_SECONDS,
  TokenResponse,
  type ClaimRequest,
  type EnrollRequest,
  type Heartbeat,
  type JobFailure,
  type JobResult,
} from "@omniralph/shared";
import type { z } from "zod";

export type FetchFn = typeof fetch;

/** A non-2xx response (or an unparseable body) from the control panel. */
export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    /** Seconds from `Retry-After` on 429/503. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
/** A claim is held up to its wait time; leave room for the response on top. */
const CLAIM_TIMEOUT_MS = (MAX_CLAIM_WAIT_SECONDS + 30) * 1000;

export interface PostOptions {
  /** Aborts the request (on top of the timeout). */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * POSTs JSON to the control panel and validates the response body. A 204's
 * body is validated as `null`.
 */
export async function postJson<S extends z.ZodType>(
  fetchFn: FetchFn,
  url: string,
  body: unknown,
  schema: S,
  accessToken?: string,
  options: PostOptions = {},
): Promise<z.infer<S>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const res = await fetchFn(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "error",
    signal: abortSignal(options),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (res.status === 204) json = null;
  const path = new URL(url).pathname;
  if (!res.ok) {
    const code =
      json && typeof json === "object" && "error" in json && typeof json.error === "string"
        ? json.error
        : undefined;
    const detail =
      json && typeof json === "object" && "message" in json && typeof json.message === "string"
        ? json.message
        : undefined;
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new ApiError(
      res.status,
      code,
      `POST ${path} failed with ${res.status}${code ? ` (${code})` : ""}${detail ? `: ${detail}` : ""}`,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(res.status, "invalid_response", `POST ${path} returned an invalid body`);
  }
  return parsed.data;
}

function abortSignal({ signal, timeoutMs = REQUEST_TIMEOUT_MS }: PostOptions): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/** `POST /api/harness/enroll`: exchanges a one-time enrollment token. */
export function enroll(
  server: string,
  request: EnrollRequest,
  fetchFn: FetchFn = fetch,
): Promise<EnrollResponse> {
  return postJson(fetchFn, `${server}/api/harness/enroll`, request, EnrollResponse);
}

/** `POST /api/harness/token`: exchanges (and rotates) the refresh token. */
export function exchangeRefreshToken(
  server: string,
  refreshToken: string,
  fetchFn: FetchFn = fetch,
): Promise<TokenResponse> {
  return postJson(fetchFn, `${server}/api/harness/token`, { refreshToken }, TokenResponse);
}

/** The authenticated agent API. Every call uses the current access token. */
export interface ControlPanelApi {
  heartbeat(body: Heartbeat): Promise<HeartbeatResponse>;
  /**
   * `POST /api/harness/claim`: long-polls for a job of the given pools (or a `system` job).
   * Null when the wait passed with nothing to claim (204).
   */
  claim(body: ClaimRequest, signal?: AbortSignal): Promise<JobStartResponse | null>;
  submitResult(jobId: string, body: JobResult): Promise<JobOutcomeResponse>;
  submitFailure(jobId: string, body: JobFailure): Promise<JobOutcomeResponse>;
}

export class HttpControlPanelApi implements ControlPanelApi {
  constructor(
    private readonly server: string,
    private readonly accessToken: () => Promise<string>,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private async post<S extends z.ZodType>(
    path: string,
    body: unknown,
    schema: S,
    options?: PostOptions,
  ) {
    return postJson(
      this.fetchFn,
      `${this.server}${path}`,
      body,
      schema,
      await this.accessToken(),
      options,
    );
  }

  heartbeat(body: Heartbeat): Promise<HeartbeatResponse> {
    return this.post("/api/harness/heartbeat", body, HeartbeatResponse);
  }

  claim(body: ClaimRequest, signal?: AbortSignal): Promise<JobStartResponse | null> {
    return this.post("/api/harness/claim", body, JobStartResponse.nullable(), {
      signal,
      timeoutMs: CLAIM_TIMEOUT_MS,
    });
  }

  submitResult(jobId: string, body: JobResult): Promise<JobOutcomeResponse> {
    return this.post(
      `/api/harness/jobs/${encodeURIComponent(jobId)}/result`,
      body,
      JobOutcomeResponse,
    );
  }

  submitFailure(jobId: string, body: JobFailure): Promise<JobOutcomeResponse> {
    return this.post(
      `/api/harness/jobs/${encodeURIComponent(jobId)}/fail`,
      body,
      JobOutcomeResponse,
    );
  }
}
