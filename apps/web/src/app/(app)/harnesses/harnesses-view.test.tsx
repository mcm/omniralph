// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, queryWrapper, testUser } from "@/components/query-test-utils";
import type { HarnessRow } from "@/lib/harnesses/rows";
import { HarnessesView } from "./harnesses-view";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

const HARNESS_ID = "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f";
const ENROLLMENT_ID = "0b6a3c1e-8f4d-4c2a-9e1b-7d5f3a2c1b0e";

function harness(overrides: Partial<HarnessRow> = {}): HarnessRow {
  return {
    id: HARNESS_ID,
    name: "coder-1",
    online: false,
    revoked: false,
    version: "1.0.0",
    desiredVersion: null,
    desiredVersionOverride: null,
    tracksLatest: false,
    selfUpdate: "supported",
    update: null,
    failedVersions: [],
    updateRequest: null,
    updateStatus: "up_to_date",
    acceptedTaskTypes: ["review"],
    maxConcurrency: 2,
    overrides: { maxConcurrency: null },
    defaults: { maxConcurrency: 2 },
    poolLimits: {},
    effectivePoolLimits: { short: 2, long: 1 },
    runningJobs: [],
    pinnedRepositories: [],
    lastHeartbeatAt: null,
    revokedAt: null,
    createdAt: "2026-10-16T10:00:00.000Z",
    ...overrides,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Answers `fetch` by path: a function of the request, or a JSON body. */
function mockFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0]!;
    const route = routes[path];
    if (!route) throw new Error(`unexpected fetch ${path}`);
    return route(init);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderView(role: "admin" | "member" = "admin") {
  const client = createTestQueryClient();
  render(<HarnessesView />, { wrapper: queryWrapper(client, { ...testUser, role }) });
  return client;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("HarnessesView", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a skeleton, then the harnesses, online by the browser's clock", async () => {
    // Freeze only the clock, so a slow render still reads "5s ago" (timers stay real).
    vi.useFakeTimers({ toFake: ["Date"] });
    const recent = new Date(Date.now() - 5_000).toISOString();
    mockFetch({
      // The server rendered it offline; the browser's clock decides.
      "/api/ui/harnesses": () =>
        json({ harnesses: [harness({ online: false, lastHeartbeatAt: recent })] }),
    });
    renderView();
    expect(screen.getByLabelText("Loading harnesses")).toBeTruthy();
    const link = await screen.findByRole("link", { name: "coder-1" });
    expect(link.getAttribute("href")).toBe(`/harnesses/${HARNESS_ID}`);
    expect(screen.getAllByText("Online").length).toBeGreaterThan(0);
    // A slow test run can take a few seconds to render, so allow some drift.
    expect(screen.getAllByText(/^\d+s ago$/).length).toBeGreaterThan(0);
  });

  it("shows an old heartbeat as offline", async () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    mockFetch({
      "/api/ui/harnesses": () =>
        json({ harnesses: [harness({ online: true, lastHeartbeatAt: old })] }),
    });
    renderView("member");
    // Members see the name without a link.
    await screen.findByText("coder-1");
    expect(screen.queryByRole("link", { name: "coder-1" })).toBeNull();
    expect(screen.getAllByText("Offline").length).toBeGreaterThan(0);
  });

  it("shows a failed load in place with a retry", async () => {
    let fail = true;
    mockFetch({
      "/api/ui/harnesses": () =>
        fail ? json({ error: "Database unavailable." }, 500) : json({ harnesses: [] }),
    });
    renderView();
    expect(await screen.findByText("Couldn't load harnesses")).toBeTruthy();
    expect(screen.getByText("Database unavailable.")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No harnesses yet")).toBeTruthy();
  });

  it("shows the harness that enrolled with the dialog's token, with the list already updated", async () => {
    let enrolled = false;
    const fetch = mockFetch({
      "/api/ui/harnesses": () =>
        json({ harnesses: enrolled ? [harness({ name: "build-box" })] : [] }),
      "/api/ui/harness-enrollments": (init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ name: "build-box" });
        return json({
          ok: true,
          id: ENROLLMENT_ID,
          token: "ore_secret",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          command: "omniralph-agent enroll --server https://x --token ore_secret",
        });
      },
      [`/api/ui/harness-enrollments/${ENROLLMENT_ID}`]: () =>
        json({
          id: ENROLLMENT_ID,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          harness: enrolled ? { id: HARNESS_ID, name: "build-box" } : null,
        }),
    });
    const client = renderView();
    await screen.findByText("No harnesses yet");

    await userEvent.click(screen.getByRole("button", { name: "Enroll harness" }));
    await userEvent.type(screen.getByLabelText("Name"), "build-box");
    await userEvent.click(screen.getByRole("button", { name: "Generate token" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("ore_secret")).toBeTruthy();
    expect(within(dialog).getByText("Waiting for the harness to enroll…")).toBeTruthy();

    // The harness redeems the token; the next poll of the enrollment finds it.
    enrolled = true;
    await client.refetchQueries({
      queryKey: [testUser.organization.id, "harnesses", "enrollment"],
    });
    expect(await within(dialog).findByText("build-box connected")).toBeTruthy();
    const open = within(dialog).getByRole("link", { name: "Open build-box" });
    expect(open.getAttribute("href")).toBe(`/harnesses/${HARNESS_ID}`);
    // The list behind the dialog was refetched before the dialog said so.
    const listCalls = fetch.mock.calls.filter(([url]) => String(url) === "/api/ui/harnesses");
    expect(listCalls.length).toBe(2);
    await waitFor(() => expect(screen.getAllByText("build-box").length).toBeGreaterThan(0));
  });
});
