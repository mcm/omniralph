// @vitest-environment jsdom
import { UiProvider } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsHistory, SettingsHistoryEntry } from "@/lib/api/settings-history";
import type { SettingsSection } from "@/lib/live/events";
import {
  ChangeHistoryPopover,
  lastChangedText,
  NO_CHANGES,
  settingsValueText,
} from "./change-history-popover";
import { CurrentUserProvider } from "./current-user";
import { LiveProvider } from "./live/live-provider";
import { changeEvent, fakeAbly, fakeToken } from "./live/live-test-utils";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  TEST_ORGANIZATION_ID,
  testUser,
  type SeenRequest,
} from "./query-test-utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const SUBJECT = "33333333-3333-4333-8333-333333333333";
const OTHER_SUBJECT = "44444444-4444-4444-8444-444444444444";
const ACME = { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" as const };

function entry(overrides: Partial<SettingsHistoryEntry> = {}): SettingsHistoryEntry {
  return {
    id: "e1",
    organization: ACME,
    section: "connection",
    subjectId: SUBJECT,
    actor: { id: "u1", name: "Ada" },
    changedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    changes: [{ field: "name", label: "Name", before: "GitLab", after: "GitLab EU" }],
    runsSince: 3,
    ...overrides,
  };
}

let pages: Record<string, SettingsHistory>;
let seen: SeenRequest[];

const historyRequests = () => seen.filter((request) => request.path === "/api/ui/settings-history");

beforeEach(() => {
  pages = { first: { latest: null, entries: [], next: null } };
  seen = mockFetch({
    "GET /api/ui/settings-history": (request) =>
      jsonResponse(pages[request.query.get("cursor") ?? "first"]),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPopover(
  props: {
    section?: SettingsSection;
    subject?: string;
    organization?: string;
    latest?: SettingsHistoryEntry | null;
  } = {},
  live?: ReturnType<typeof fakeAbly>,
) {
  const client = createTestQueryClient();
  const popover = (
    <ChangeHistoryPopover
      section={props.section ?? "connection"}
      subject={"subject" in props ? props.subject : SUBJECT}
      organization={props.organization}
      latest={props.latest ?? null}
    />
  );
  render(
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={client}>
        <UiProvider>
          {live ? (
            <LiveProvider createClient={live.createClient} fetchToken={fakeToken}>
              {popover}
            </LiveProvider>
          ) : (
            popover
          )}
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
  return client;
}

async function open() {
  await userEvent.setup().click(screen.getByRole("button", { name: "Change history" }));
  return screen.findByRole("dialog", { name: "Change history" });
}

describe("ChangeHistoryPopover", () => {
  it("is an info button named Change history that fetches nothing until opened", () => {
    renderPopover();
    expect(screen.getByRole("button", { name: "Change history" })).toBeTruthy();
    expect(historyRequests()).toEqual([]);
  });

  it("says No changes recorded yet when the section has none", async () => {
    renderPopover();
    const popover = await open();
    expect(within(popover).getByText(NO_CHANGES)).toBeTruthy();
    await waitFor(() => expect(within(popover).queryByText("Loading changes…")).toBeNull());
    expect(within(popover).queryByRole("list", { name: "Changes" })).toBeNull();
  });

  it("says who changed it last, when, and the runs since, from latest", async () => {
    const latest = entry();
    pages.first = { latest, entries: [latest], next: null };
    renderPopover({ latest });
    const popover = await open();
    expect(within(popover).getByText("Last changed by Ada, 5 min ago, 3 runs since")).toBeTruthy();
  });

  it("lists the changes of an arbitrary section and subject: time, actor and each field", async () => {
    const latest = entry({
      changes: [
        { field: "name", label: "Name", before: "GitLab", after: "GitLab EU" },
        { field: "enabled", label: "Webhook", before: true, after: false },
        { field: "paths", label: "Skip paths", before: [], after: ["dist/**", "*.lock"] },
      ],
    });
    pages.first = { latest, entries: [latest], next: null };
    renderPopover({ latest });
    const popover = await open();
    const list = await within(popover).findByRole("list", { name: "Changes" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]!.querySelector("time")!.getAttribute("dateTime")).toBe(latest.changedAt);
    expect(items[0]!.textContent).toContain("Ada");
    expect(within(items[0]!).getByText("Name: GitLab → GitLab EU")).toBeTruthy();
    expect(within(items[0]!).getByText("Webhook: On → Off")).toBeTruthy();
    expect(within(items[0]!).getByText("Skip paths: None → dist/**, *.lock")).toBeTruthy();
    const [request] = historyRequests();
    expect(request!.query.get("section")).toBe("connection");
    expect(request!.query.get("subject")).toBe(SUBJECT);
    expect(request!.query.get("cursor")).toBeNull();
  });

  it("asks for the subject's organization and works without a subject", async () => {
    renderPopover({ section: "organization", subject: undefined, organization: "org-b" });
    await open();
    await waitFor(() => expect(historyRequests()).toHaveLength(1));
    const [request] = historyRequests();
    expect(request!.query.get("section")).toBe("organization");
    expect(request!.query.has("subject")).toBe(false);
    expect(request!.query.get("organization")).toBe("org-b");
  });

  it("pages with Show more until there is no next cursor", async () => {
    const newest = entry({ id: "e1", actor: { id: "u1", name: "Ada" } });
    const older = entry({ id: "e2", actor: { id: "u2", name: "Grace" } });
    pages.first = { latest: newest, entries: [newest], next: "c1" };
    pages.c1 = { latest: newest, entries: [older], next: null };
    renderPopover({ latest: newest });
    const popover = await open();
    const more = await within(popover).findByRole("button", { name: "Show more" });
    await userEvent.setup().click(more);
    await waitFor(() =>
      expect(
        within(within(popover).getByRole("list", { name: "Changes" })).getAllByRole("listitem")
          .length,
      ).toBe(2 + 2),
    );
    expect(popover.textContent).toContain("Grace");
    expect(historyRequests().map((request) => request.query.get("cursor"))).toEqual([null, "c1"]);
    expect(within(popover).queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("refetches while open on its section's settings event and its subject's repository event", async () => {
    const live = fakeAbly();
    renderPopover({}, live);
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
    );
    const popover = await open();
    await waitFor(() => expect(historyRequests()).toHaveLength(1));
    const deliver = (event: Parameters<typeof changeEvent>[1]) =>
      act(() =>
        live
          .current()
          .deliver(`org:${TEST_ORGANIZATION_ID}:changes`, changeEvent(TEST_ORGANIZATION_ID, event)),
      );

    const latest = entry();
    pages.first = { latest, entries: [latest], next: null };
    deliver({ resource: "settings", section: "connection", subjectId: SUBJECT, ids: [SUBJECT] });
    await waitFor(() => expect(historyRequests()).toHaveLength(2));
    await within(popover).findByText("Last changed by Ada, 5 min ago, 3 runs since");

    deliver({ resource: "repository", ids: [SUBJECT] });
    await waitFor(() => expect(historyRequests()).toHaveLength(3));

    // Another subject's or section's changes leave it alone.
    deliver({
      resource: "settings",
      section: "connection",
      subjectId: OTHER_SUBJECT,
      ids: [OTHER_SUBJECT],
    });
    deliver({ resource: "settings", section: "organization", ids: [SUBJECT] });
    deliver({ resource: "repository", ids: [OTHER_SUBJECT] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(historyRequests()).toHaveLength(3);
  });
});

describe("settingsValueText and lastChangedText", () => {
  it("words values and the latest change", () => {
    expect(settingsValueText(null)).toBe("None");
    expect(settingsValueText("")).toBe("None");
    expect(settingsValueText(false)).toBe("Off");
    expect(settingsValueText(12)).toBe("12");
    expect(settingsValueText(["a", "b"])).toBe("a, b");
    const now = Date.parse("2026-10-26T12:00:00Z");
    expect(lastChangedText(entry({ changedAt: "2026-10-26T11:58:00Z", runsSince: 1 }), now)).toBe(
      "Last changed by Ada, 2 min ago, 1 run since",
    );
  });
});
