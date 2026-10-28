/**
 * The page's requests to the agent's local API (`/api/*`, same origin, the token cookie sent
 * by the browser). Errors arrive as `{ error, issues? }`; a 401 means the agent restarted (so
 * the token changed) or the page was opened without the token, and switches the whole page
 * to "Open this page again" (`useUnauthorized`).
 */
import { useSyncExternalStore } from "react";

/** Shown when a request fails without a message from the agent. */
export const REQUEST_FAILED = "Something went wrong. Try again.";

export interface LocalApiIssue {
  path: (string | number)[];
  message: string;
}

/** A failed request: the agent's `error` as the message, with its status and `issues`. */
export class LocalApiError extends Error {
  readonly status: number;
  readonly issues: LocalApiIssue[];
  /** The whole error body (e.g. a 409's current settings). */
  readonly body: unknown;

  constructor(message: string, status: number, issues: LocalApiIssue[] = [], body?: unknown) {
    super(message);
    this.name = "LocalApiError";
    this.status = status;
    this.issues = issues;
    this.body = body;
  }

  /** The issues by field (the issue's path joined with "."), for a staged card. */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries(this.issues.map((issue) => [issue.path.join("."), issue.message]));
  }
}

// The 401 state: once set it stays for the page's lifetime (only a new link fixes it).
let unauthorized = false;
const listeners = new Set<() => void>();

export function markUnauthorized(): void {
  if (unauthorized) return;
  unauthorized = true;
  for (const listener of listeners) listener();
}

/** For tests: back to authorized. */
export function resetUnauthorized(): void {
  unauthorized = false;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a request has answered 401. */
export function useUnauthorized(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => unauthorized,
    () => false,
  );
}

function errorBody(body: unknown): { error?: string; issues: LocalApiIssue[] } {
  if (typeof body !== "object" || body === null) return { issues: [] };
  const { error, issues } = body as { error?: unknown; issues?: unknown };
  return {
    error: typeof error === "string" ? error : undefined,
    issues: Array.isArray(issues) ? (issues as LocalApiIssue[]) : [],
  };
}

export interface LocalRequestInit {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

/** Calls `path` (under `/api`) and returns its JSON; throws a `LocalApiError` otherwise. */
export async function localRequest<T>(path: string, init: LocalRequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(init.body !== undefined && { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
      signal: init.signal,
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new LocalApiError("Can't reach the agent. Is it still running?", 0);
  }
  if (response.status === 401) markUnauthorized();
  const text = await response.text();
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const { error, issues } = errorBody(body);
    throw new LocalApiError(error ?? REQUEST_FAILED, response.status, issues, body);
  }
  return body as T;
}
