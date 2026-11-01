// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { UiProvider } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider } from "@/components/current-user";
import { LiveProvider } from "@/components/live/live-provider";
import { changeEvent, fakeAbly, fakeToken } from "@/components/live/live-test-utils";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  TEST_ORGANIZATION_ID,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import type { RunDetail, RunSession as RunSessionData } from "@/lib/api/runs";
import { RunSession } from "./run-session";
import { EMPTY_SESSION, runSession } from "./test-fixtures";

vi.mock("next/navigation", () => ({
  usePathname: () => "/runs",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

/** A UUID, so the run's change events reach its queries. */
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_PATH = `/api/ui/runs/${RUN_ID}/session`;

let pages: Record<string, () => Response>;
let seen: SeenRequest[];

function serve() {
  seen = mockFetch({
    [`GET ${SESSION_PATH}`]: (request) => pages[request.query.get("cursor") ?? ""]!(),
  });
}

function renderSession(kind: RunDetail["kind"] = "epic", live?: ReturnType<typeof fakeAbly>): void {
  const view = <RunSession run={{ id: RUN_ID, kind, tracker: "linear", workItem: null }} />;
  render(
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={createTestQueryClient()}>
        <UiProvider>
          {live ? (
            <LiveProvider createClient={live.createClient} fetchToken={fakeToken}>
              {view}
            </LiveProvider>
          ) : (
            view
          )}
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
}

const section = () => document.querySelector<HTMLDetailsElement>("details.or-run-session");
const loaded = () => waitFor(() => expect(section()).not.toBeNull());
const subsection = (name: string) => screen.getByRole("region", { name });
const headings = () =>
  within(section()!)
    .getAllByRole("heading", { level: 4 })
    .map((h) => h.textContent);
const requests = () => seen.filter((r) => r.path === SESSION_PATH);
/** An element's text, with its badges' spacing collapsed. */
const text = (element: Element) => element.textContent!.replace(/\s+/g, " ").trim();

beforeEach(() => {
  pages = { "": () => jsonResponse(runSession()) };
  serve();
});
afterEach(() => vi.unstubAllGlobals());

describe("RunSession", () => {
  it("is a collapsed section titled Session with its subsections in order", async () => {
    renderSession();
    await loaded();
    expect(section()!.open).toBe(false);
    expect(section()!.querySelector("summary")!.textContent).toBe("Session");
    expect(headings()).toEqual([
      "Pending requests",
      "Messages",
      "Guidance",
      "Recommendations",
      "Progress log",
    ]);
  });

  it("shows each pending request with its author, repo and time", async () => {
    renderSession();
    await loaded();
    const [request] = within(subsection("Pending requests")).getAllByRole("listitem");
    expect(text(request!)).toContain("Open the merge request when the tests pass");
    expect(text(request!)).toContain("Ada");
    expect(text(request!)).toContain("acme/web");
  });

  it("shows each message's kind, author, attempt and delivery state, newest first", async () => {
    renderSession();
    await loaded();
    const [waiting, kept] = within(subsection("Messages")).getAllByRole("listitem").map(text);
    expect(waiting).toContain("Use the new billing client");
    expect(waiting).toContain("Guidance");
    expect(waiting).toContain("Bo");
    expect(waiting).toContain("For: Building TOOL-2");
    expect(waiting).toContain("Waiting for delivery");
    expect(kept).toContain("For: Built TOOL-1");
    expect(kept).toContain("Not delivered: kept as guidance");
    // Rule 7: no raw job types.
    expect(text(section()!)).not.toMatch(/ralph\.|story\.run/);
  });

  it("shows the guidance, Om's recommendations with their story, and the progress log as preformatted text", async () => {
    renderSession();
    await loaded();
    expect(text(subsection("Guidance"))).toContain("Keep the CSV header");
    const recommendation = text(subsection("Recommendations"));
    expect(recommendation).toContain("Fix the SDK's retry");
    expect(recommendation).toContain("It retries POSTs.");
    expect(recommendation).toContain("TOOL-1");
    expect(recommendation).toContain("Story 1");
    expect(
      within(subsection("Recommendations")).getByRole("link", { name: /TOOL-1/ }),
    ).toHaveProperty("href", "https://linear.app/acme/issue/TOOL-1");
    const log = subsection("Progress log").querySelector("pre")!;
    expect(log.classList.contains("or-mono")).toBe(true);
    expect(log.textContent).toBe("## TOOL-1\n- export built\n");
  });

  it("leaves empty subsections out", async () => {
    pages[""] = () =>
      jsonResponse(runSession({ pendingRequests: [], recommendations: [], progressLog: "  \n" }));
    renderSession();
    await loaded();
    expect(headings()).toEqual(["Messages", "Guidance"]);
  });

  it("is left out when every subsection is empty, and for runs without a session", async () => {
    pages[""] = () => jsonResponse(EMPTY_SESSION);
    renderSession();
    await waitFor(() => expect(requests()).toHaveLength(1));
    // Settled: still nothing.
    await act(async () => {});
    expect(section()).toBeNull();

    seen.length = 0;
    renderSession("review");
    await act(async () => {});
    expect(requests()).toHaveLength(0);
    expect(section()).toBeNull();
  });

  it("loads older messages with the cursor", async () => {
    const older: RunSessionData = runSession({
      messages: [
        {
          id: "message-0",
          kind: "request",
          text: "Rename the export",
          author: null,
          attempt: { id: "a0", label: "Didn't build TOOL-1" },
          state: "undelivered",
          createdAt: "2026-10-26T08:00:00.000Z",
          settledAt: null,
        },
      ],
      nextCursor: null,
    });
    pages = {
      "": () => jsonResponse(runSession({ nextCursor: "page-2" })),
      "page-2": () => jsonResponse(older),
    };
    renderSession();
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "Show older messages" }));
    await waitFor(() =>
      expect(within(subsection("Messages")).getAllByRole("listitem")).toHaveLength(3),
    );
    expect(requests().at(-1)!.query.get("cursor")).toBe("page-2");
    expect(text(within(subsection("Messages")).getAllByRole("listitem")[2]!)).toContain(
      "Not delivered: the attempt ended",
    );
    expect(screen.queryByRole("button", { name: "Show older messages" })).toBeNull();
  });

  it("says when the session couldn't load, and retries", async () => {
    let fail = true;
    pages[""] = () =>
      fail ? jsonResponse({ error: "Something went wrong." }, 500) : jsonResponse(runSession());
    renderSession();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load the session.");
    fail = false;
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(headings()).toContain("Messages"));
  });

  it("refetches on the run's change event", async () => {
    const live = fakeAbly();
    renderSession("epic", live);
    await loaded();
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
    );
    const before = requests().length;
    pages[""] = () =>
      jsonResponse(runSession({ progressLog: "## TOOL-1\n- export built\n## TOOL-2\n- done\n" }));
    act(() =>
      live
        .current()
        .deliver(
          `org:${TEST_ORGANIZATION_ID}:changes`,
          changeEvent(TEST_ORGANIZATION_ID, { resource: "run", runId: RUN_ID }),
        ),
    );
    await waitFor(() => expect(requests().length).toBeGreaterThan(before));
    await waitFor(() => expect(subsection("Progress log").textContent).toContain("## TOOL-2"));
  });
});
