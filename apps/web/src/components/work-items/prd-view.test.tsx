// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider } from "@omniralph/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
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
import { backlogKeys, queryKeys } from "@/lib/api/keys";
import type { WorkItemDetail } from "@/lib/api/work-items";
import { PRD_EMPTY, PrdView } from "./prd-view";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/backlog",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const ORG = TEST_ORGANIZATION_ID;
const ID = "linear-issue-412";
const DETAIL_PATH = `/api/ui/work-items/${ID}`;
const PRD_PATH = `${DETAIL_PATH}/prd`;
const PRD = "## Introduction\n\nShow the **backlog**.\n\n## Quality Gates\n\n- `pnpm test`\n";
const CONFLICT = "SOC-412 changed in Linear since you opened it.";
const IN_FLIGHT = "Om is working on SOC-412. Edit the PRD when the run stops.";

function workItem(overrides: Partial<WorkItemDetail> = {}): WorkItemDetail {
  return {
    id: ID,
    tracker: "linear",
    identifier: "SOC-412",
    title: "Backlog screen",
    url: "https://linear.app/acme/issue/SOC-412",
    organization: { id: ORG, name: "Acme", role: "admin" },
    repository: { id: "repo-1", provider: "github", fullPath: "acme/customer-portal" },
    size: "M",
    group: "ready",
    blocked: false,
    source: { kind: "team", id: "team-1", name: "SOC" },
    state: { category: "todo", name: "Todo" },
    description: PRD,
    updatedAt: "2026-10-26T10:00:00.000Z",
    blockedBy: [],
    route: {
      outcome: "repository",
      repository: { id: "repo-1", provider: "github", fullPath: "acme/customer-portal" },
      via: { kind: "team", label: "SOC team" },
      by: "work item match (SOC team)",
    },
    stories: [],
    activity: [],
    triageRunning: false,
    run: null,
    actions: {
      start: true,
      triage: true,
      editPrd: true,
      changeRepo: true,
      move: true,
      cancel: true,
    },
    ...overrides,
  };
}

let detail: WorkItemDetail;
let savePrd: (request: SeenRequest) => Response | Promise<Response>;
let seen: SeenRequest[];
let client: QueryClient;

function renderView(
  mode: "editable" | "read-only" = "editable",
  live?: ReturnType<typeof fakeAbly>,
) {
  const view = <PrdView workItemId={ID} mode={mode} />;
  return render(
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={client}>
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

const loaded = () => screen.findByRole("heading", { name: "Introduction" });
const editor = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: /PRD of SOC-412/ });
const button = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });
const detailFetches = () => seen.filter((r) => r.method === "GET" && r.path === DETAIL_PATH);

/** Opens the editor and replaces its text with `text`. */
async function edit(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(button("Edit PRD"));
  await user.clear(editor());
  await user.type(editor(), text);
}

beforeEach(() => {
  detail = workItem();
  savePrd = () => jsonResponse({ updatedAt: "2026-10-26T10:05:00.000Z" });
  client = createTestQueryClient();
  ui.toast.mockReset();
  seen = mockFetch({
    [`GET ${DETAIL_PATH}`]: () => jsonResponse(detail),
    [`PUT ${PRD_PATH}`]: (request) => savePrd(request),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("PrdView read-only", () => {
  it("renders the description with Markdown and no edit control", async () => {
    renderView("read-only");
    await loaded();
    expect(screen.getByText("backlog").tagName).toBe("STRONG");
    // Markdown's Quality Gates list is numbered.
    expect(document.querySelector("ol.or-md__gates")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Edit PRD" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("says when there is no PRD yet", async () => {
    detail = workItem({ description: "" });
    renderView("read-only");
    expect(await screen.findByRole("heading", { name: PRD_EMPTY })).toBeTruthy();
  });

  it("loads the detail through GET /api/ui/work-items/{id}", async () => {
    renderView("read-only");
    await loaded();
    expect(detailFetches()).toHaveLength(1);
  });
});

describe("PrdView editable", () => {
  it("renders as read-only when the item can't be edited now (actions.editPrd false)", async () => {
    detail = workItem({ actions: { ...workItem().actions, editPrd: false } });
    renderView("editable");
    await loaded();
    expect(screen.queryByRole("button", { name: "Edit PRD" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("swaps in a mono Textarea with Save (solid neutral) and Cancel; Save waits for a change", async () => {
    const user = userEvent.setup();
    renderView();
    await loaded();
    await user.click(button("Edit PRD"));

    expect(editor().value).toBe(PRD);
    expect(editor().classList).toContain("or-input--mono");
    expect(screen.queryByRole("heading", { name: "Introduction" })).toBeNull();
    const save = button("Save");
    expect(save.classList).toContain("or-btn--solid");
    expect(save.classList).not.toContain("or-btn--primary");
    expect(save.disabled).toBe(true);
    expect(button("Cancel")).toBeTruthy();

    await user.type(editor(), "More.");
    expect(button("Save").disabled).toBe(false);
    // Back to the original text: nothing to save.
    await user.clear(editor());
    await user.type(editor(), PRD.replace(/\n/g, "{Enter}").replace(/`/g, "`"));
    expect(editor().value).toBe(PRD);
    expect(button("Save").disabled).toBe(true);
  });

  it("Cancel drops the edit and shows the PRD again", async () => {
    const user = userEvent.setup();
    renderView();
    await loaded();
    await edit(user, "# Draft");
    await user.click(button("Cancel"));
    expect(screen.getByRole("heading", { name: "Introduction" })).toBeTruthy();
    expect(seen.some((r) => r.method === "PUT")).toBe(false);
  });

  it("Save sends the text with baseUpdatedAt, shows it at once and takes the response's updatedAt", async () => {
    let answer!: () => void;
    savePrd = () =>
      new Promise((resolve) => {
        answer = () => resolve(jsonResponse({ updatedAt: "2026-10-26T10:05:00.000Z" }));
      });
    const user = userEvent.setup();
    renderView();
    await loaded();
    await edit(user, "# New PRD");
    await user.click(button("Save"));

    // Before the server answers: the new text shows, in the cached detail too.
    expect(await screen.findByRole("heading", { name: "New PRD" })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    const put = seen.find((r) => r.method === "PUT" && r.path === PRD_PATH);
    expect(put?.body).toEqual({ markdown: "# New PRD", baseUpdatedAt: "2026-10-26T10:00:00.000Z" });
    const cached = () =>
      client.getQueryData<WorkItemDetail>(backlogKeys(queryKeys(ORG)).detail(ID));
    expect(cached()?.description).toBe("# New PRD");
    expect(cached()?.updatedAt).toBe("2026-10-26T10:00:00.000Z");

    // The reconcile refetch reads what the tracker now holds.
    detail = workItem({ description: "# New PRD", updatedAt: "2026-10-26T10:05:00.000Z" });
    await act(async () => answer());
    await waitFor(() => expect(cached()?.updatedAt).toBe("2026-10-26T10:05:00.000Z"));
    expect(screen.getByRole("heading", { name: "New PRD" })).toBeTruthy();
    expect(ui.toast).toHaveBeenCalledWith("PRD saved");
  });

  it("applies the response's updatedAt to the next edit", async () => {
    let answer!: () => void;
    savePrd = () =>
      new Promise((resolve) => {
        answer = () => resolve(jsonResponse({ updatedAt: "2026-10-26T10:05:00.000Z" }));
      });
    // The background refetch is held back, so only applyResult can move updatedAt.
    let refetched = false;
    seen = mockFetch({
      [`GET ${DETAIL_PATH}`]: () => {
        if (refetched) return new Promise<Response>(() => {});
        refetched = true;
        return jsonResponse(detail);
      },
      [`PUT ${PRD_PATH}`]: (request) => savePrd(request),
    });
    const user = userEvent.setup();
    renderView();
    await loaded();
    await edit(user, "# New PRD");
    await user.click(button("Save"));
    await act(async () => answer());
    await waitFor(() => expect(button("Edit PRD").disabled).toBe(false));

    savePrd = () => jsonResponse({ updatedAt: "2026-10-26T10:06:00.000Z" });
    await edit(user, "# Newer PRD");
    await user.click(button("Save"));
    const puts = seen.filter((r) => r.method === "PUT");
    expect(puts.at(-1)?.body).toEqual({
      markdown: "# Newer PRD",
      baseUpdatedAt: "2026-10-26T10:05:00.000Z",
    });
  });

  it.each([
    ["the item changed in Linear", CONFLICT],
    ["Om is working on the item", IN_FLIGHT],
  ])("a 409 when %s keeps the text in the editor and shows why in an alert", async (_, message) => {
    savePrd = () => jsonResponse({ error: message, code: "conflict" }, 409);
    const user = userEvent.setup();
    renderView();
    await loaded();
    await edit(user, "# My edit");
    await user.click(button("Save"));

    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(editor().value).toBe("# My edit");
    expect(button("Save").disabled).toBe(false);
    // The cached description is back to the tracker's.
    expect(
      client.getQueryData<WorkItemDetail>(backlogKeys(queryKeys(ORG)).detail(ID))?.description,
    ).toBe(PRD);
    expect(ui.toast).toHaveBeenCalledWith(message, { variant: "danger" });
  });

  it("keeps the text in the editor on any other failure, without the alert", async () => {
    savePrd = () => jsonResponse({ error: "Linear didn't answer." }, 502);
    const user = userEvent.setup();
    renderView();
    await loaded();
    await edit(user, "# My edit");
    await user.click(button("Save"));

    await waitFor(() => expect(editor().value).toBe("# My edit"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(ui.toast).toHaveBeenCalledWith("Linear didn't answer.", { variant: "danger" });
  });
});

describe("PrdView live", () => {
  const deliver = (live: ReturnType<typeof fakeAbly>) =>
    act(() =>
      live
        .current()
        .deliver(`org:${ORG}:changes`, changeEvent(ORG, { resource: "work_item", ids: [ID] })),
    );
  const subscribed = (live: ReturnType<typeof fakeAbly>) =>
    waitFor(() => expect(live.current().subscribed()).toContain(`org:${ORG}:changes`));

  it("refetches the PRD on a work_item event for the item while not editing", async () => {
    const live = fakeAbly();
    renderView("editable", live);
    await loaded();
    await subscribed(live);

    detail = workItem({ description: "## Changed in Linear" });
    deliver(live);
    expect(await screen.findByRole("heading", { name: "Changed in Linear" })).toBeTruthy();
    expect(detailFetches()).toHaveLength(2);
  });

  it("never replaces text being edited, and saves against the version the edit started from", async () => {
    const live = fakeAbly();
    const user = userEvent.setup();
    renderView("editable", live);
    await loaded();
    await subscribed(live);
    await edit(user, "# My edit");

    detail = workItem({
      description: "## Changed in Linear",
      updatedAt: "2026-10-26T10:03:00.000Z",
    });
    deliver(live);
    await waitFor(() => expect(detailFetches()).toHaveLength(2));
    await waitFor(() =>
      expect(
        client.getQueryData<WorkItemDetail>(backlogKeys(queryKeys(ORG)).detail(ID))?.updatedAt,
      ).toBe("2026-10-26T10:03:00.000Z"),
    );
    expect(editor().value).toBe("# My edit");

    await user.click(button("Save"));
    const put = seen.find((r) => r.method === "PUT");
    expect(put?.body).toEqual({ markdown: "# My edit", baseUpdatedAt: "2026-10-26T10:00:00.000Z" });
  });

  it("ignores another item's events", async () => {
    const live = fakeAbly();
    renderView("read-only", live);
    await loaded();
    await subscribed(live);
    act(() =>
      live
        .current()
        .deliver(
          `org:${ORG}:changes`,
          changeEvent(ORG, { resource: "work_item", ids: ["linear-other"] }),
        ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(detailFetches()).toHaveLength(1);
  });
});
