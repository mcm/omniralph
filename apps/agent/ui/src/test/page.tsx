/**
 * Test helpers for the agent page: a fake `EventSource`, a fake local API (`fetch`), a
 * `ResizeObserver` that reports a chosen width (so `SplitView` shows one pane or both) and
 * `renderAgentPage`, which renders the whole page at a path.
 */
import {
  effectiveLocalSettings,
  type AgentLocalSettings,
  type AgentUpdateStateName,
} from "@omniralph/shared";
import { clearToasts } from "@omniralph/ui";
import { act, cleanup, render } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { afterEach, vi } from "vitest";
import { resetUnauthorized } from "../api.js";
import type { AgentUiChange } from "../live/invalidations.js";
import type { LiveEventSource } from "../live/live-provider.js";
import { AgentPageRoot } from "../main.js";
import { createAgentQueryClient } from "../query-client.js";
import type { LocalSettingsState } from "../../../src/settings.js";
import type { AgentUiState, NavProblem } from "../state.js";

afterEach(() => {
  cleanup();
  resetUnauthorized();
  clearToasts();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

type Listener = (event: MessageEvent | Event) => void;

/** One stream the page opened; drive it with `open`, `change` and `fail`. */
export class FakeEventSource implements LiveEventSource {
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  private emit(type: string, event: MessageEvent | Event): void {
    act(() => {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    });
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }

  change(change: Omit<AgentUiChange, "v" | "at">): void {
    const data = JSON.stringify({ v: 1, at: new Date().toISOString(), ...change });
    this.emit("change", new MessageEvent("change", { data }));
  }

  /** The stream dropped (the browser retries) or, with `closed`, answered an error. */
  fail({ closed = false }: { closed?: boolean } = {}): void {
    this.readyState = closed ? 2 : 0;
    this.emit("error", new Event("error"));
  }
}

/** Every stream opened, newest last. */
export function fakeEventSources() {
  const sources: FakeEventSource[] = [];
  const create = (url: string) => {
    const source = new FakeEventSource(url);
    sources.push(source);
    return source;
  };
  return { sources, create, latest: () => sources.at(-1)! };
}

export interface FakeReply {
  status?: number;
  body?: unknown;
}

export type FakeRoute =
  FakeReply | ((init: RequestInit | undefined) => FakeReply | Promise<FakeReply>);

/**
 * Stubs `fetch` with replies by "METHOD /path" (or "/path" for GET). Unknown requests answer
 * 404. Returns the requests made, as "METHOD /path".
 */
export function fakeApi(routes: Record<string, FakeRoute>) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.href);
    const method = init?.method ?? "GET";
    const key = `${method} ${url.pathname}`;
    calls.push(key);
    const route = routes[key] ?? (method === "GET" ? routes[url.pathname] : undefined);
    const reply =
      route === undefined
        ? { status: 404, body: { error: "Not found" } }
        : typeof route === "function"
          ? await route(init)
          : route;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch, count: (key: string) => calls.filter((call) => call === key).length };
}

/** `ResizeObserver` reporting `width` for every observed element (0 means none reported). */
export function stubContainerWidth(width: number): void {
  class WidthObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [{ target, contentRect: { width } as DOMRectReadOnly } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", WidthObserver);
}

export const WIDE = 1200;
export const NARROW = 390;

/** `/api/state`'s `settings` for the contents of `settings.json`. */
export function settingsState(
  settings: AgentLocalSettings = { v: 1 },
  { revision = "none", lastError = null }: { revision?: string; lastError?: string | null } = {},
): LocalSettingsState {
  return { settings, effective: effectiveLocalSettings(settings), revision, lastError };
}

/** The update part of `/api/state`: idle, under pm2, nothing failed. */
export function updateState(
  overrides: {
    state?: AgentUpdateStateName;
    version?: string | null;
    error?: string | null;
    failedVersions?: string[];
    selfUpdate?: "supported" | "unsupported";
    request?: AgentUiState["update"]["request"];
  } = {},
): AgentUiState["update"] {
  return {
    selfUpdate: overrides.selfUpdate ?? "supported",
    update: {
      state: overrides.state ?? "idle",
      version: overrides.version ?? null,
      previous: null,
      startsSincePending: 0,
      error: overrides.error ?? null,
    },
    failedVersions: overrides.failedVersions ?? [],
    request: overrides.request ?? null,
  };
}

export function agentState(
  overrides: {
    problems?: NavProblem[];
    settings?: LocalSettingsState;
    update?: AgentUiState["update"];
    versionPolicy?: AgentUiState["versionPolicy"];
    hostTools?: Partial<AgentUiState["hostTools"]>;
  } = {},
): AgentUiState {
  return {
    agent: {
      agentId: "3c1d0b8e-0000-4000-8000-000000000080",
      name: "build-01",
      server: "https://omniralph.example.com",
      version: "2.0.3",
    },
    status: {
      stopping: false,
      draining: false,
      connected: true,
      lastHeartbeatAt: "2026-10-28T10:00:00.000Z",
      unreachableSince: null,
      revoked: false,
      runningJobIds: [],
      maxConcurrency: 5,
    },
    connection: {
      connected: true,
      lastHeartbeatAt: "2026-10-28T10:00:00.000Z",
      unreachableSince: null,
      revoked: false,
    },
    settings: overrides.settings ?? settingsState(),
    update: overrides.update ?? updateState(),
    versionPolicy: overrides.versionPolicy ?? null,
    claude: null,
    hostTools: { tools: [], required: [], blockedExecPaths: [], ...overrides.hostTools },
    missingRequiredHostTools: [],
    filesystems: [],
    problems: overrides.problems ?? [],
  } as unknown as AgentUiState;
}

export interface RenderAgentPageOptions {
  path?: string;
  width?: number;
  queryClient?: QueryClient;
  createEventSource?: (url: string) => LiveEventSource;
}

/** Renders the page at `path` in a container `width` wide (wide by default). */
export function renderAgentPage({
  path = "/",
  width = WIDE,
  queryClient = createAgentQueryClient(),
  createEventSource = fakeEventSources().create,
}: RenderAgentPageOptions = {}) {
  window.history.replaceState(null, "", path);
  stubContainerWidth(width);
  const view = render(
    <AgentPageRoot queryClient={queryClient} createEventSource={createEventSource} />,
  );
  return { ...view, queryClient };
}
