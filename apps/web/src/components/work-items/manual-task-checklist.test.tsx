// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider } from "@/components/current-user";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  TEST_ORGANIZATION_ID,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import type { WorkItemDetail } from "@/lib/api/work-items";
import { setTaskChecked } from "@/lib/work-items/task-list";
import { storyDetail } from "@/screens/inbox/test-fixtures";
import { MARK_DONE, ManualTaskChecklist, NO_TASKS, plainTaskText } from "./manual-task-checklist";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const ID = "linear-story-42";
const DETAIL_PATH = `/api/ui/work-items/${ID}`;

let detail: WorkItemDetail;
let toggle: (request: SeenRequest) => Response | Promise<Response>;
let seen: SeenRequest[];

function renderChecklist(props: { markDone?: boolean; showDescription?: boolean } = {}) {
  render(
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={createTestQueryClient()}>
        <UiProvider>
          <ManualTaskChecklist workItemId={ID} {...props} />
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
}

const boxes = () => screen.getAllByRole<HTMLInputElement>("checkbox");
const box = (name: string) => screen.getByRole<HTMLInputElement>("checkbox", { name });
const puts = () => seen.filter((r) => r.method === "PUT");

/** A response held until the test settles it. */
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  detail = storyDetail({
    description: [
      "Do these:",
      "",
      "- [x] Export the old cert",
      "- [ ] Install the **new** one",
      "```",
      "- [ ] not a task",
      "```",
    ].join("\n"),
  });
  // Linear saves the change: later reads see it.
  toggle = (request) => {
    const body = request.body as { index: number; checked: boolean };
    detail = {
      ...detail,
      description: setTaskChecked(detail.description, body.index, body.checked),
    };
    return jsonResponse({ description: detail.description, updatedAt: `saved-${body.index}` });
  };
  ui.toast.mockReset();
  seen = mockFetch({
    [`GET ${DETAIL_PATH}`]: () => jsonResponse(detail),
    [`PUT ${DETAIL_PATH}/tasks`]: (request) => toggle(request),
    [`POST ${DETAIL_PATH}/done`]: () => jsonResponse({ ok: true }),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("ManualTaskChecklist", () => {
  it("shows the description's tasks as checkboxes with their progress, leaving code alone", async () => {
    renderChecklist();
    await waitFor(() => expect(boxes()).toHaveLength(2));
    expect(box("Export the old cert").checked).toBe(true);
    expect(box("Install the new one").checked).toBe(false);
    expect(screen.getByText("1 of 2 done")).toBeTruthy();
  });

  it("checking a task shows it at once and writes it to Linear by position and text", async () => {
    const held = deferred();
    toggle = () => held.promise;
    const user = userEvent.setup();
    renderChecklist();
    await waitFor(() => expect(boxes()).toHaveLength(2));
    await user.click(box("Install the new one"));
    // Optimistic: checked before the server answers.
    expect(box("Install the new one").checked).toBe(true);
    expect(screen.getByText("2 of 2 done")).toBeTruthy();
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.body).toEqual({ index: 1, text: "Install the **new** one", checked: true });
    expect(puts()[0]!.query.get("organization")).toBe(TEST_ORGANIZATION_ID);
    held.resolve(
      jsonResponse({
        description: detail.description.replace("- [ ] Install", "- [x] Install"),
        updatedAt: "saved",
      }),
    );
    await waitFor(() => expect(box("Install the new one").checked).toBe(true));
  });

  it("puts the box back and says why when Linear refuses", async () => {
    toggle = () => jsonResponse({ error: "That task changed in TOOL-42." }, 409);
    const user = userEvent.setup();
    renderChecklist();
    await waitFor(() => expect(boxes()).toHaveLength(2));
    await user.click(box("Export the old cert"));
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith(
        "That task changed in TOOL-42.",
        expect.objectContaining({ variant: "danger" }),
      ),
    );
    expect(box("Export the old cert").checked).toBe(true);
  });

  it("without a task list: the description and what to do instead", async () => {
    detail = storyDetail({ description: "Call the registrar and renew the domain." });
    renderChecklist();
    expect(await screen.findByText(NO_TASKS)).toBeTruthy();
    expect(screen.getByText("Call the registrar and renew the domain.")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("can leave the description to the PRD beside it", async () => {
    detail = storyDetail({ description: "Call the registrar." });
    renderChecklist({ showDescription: false });
    expect(await screen.findByText(NO_TASKS)).toBeTruthy();
    expect(screen.queryByText("Call the registrar.")).toBeNull();
  });

  it("Mark done is primary once every task is checked, and moves the item to Done", async () => {
    const user = userEvent.setup();
    renderChecklist({ markDone: true });
    await waitFor(() => expect(boxes()).toHaveLength(2));
    const markDone = () => screen.getByRole("button", { name: MARK_DONE });
    expect(markDone().classList.contains("or-btn--primary")).toBe(false);
    await user.click(box("Install the new one"));
    await waitFor(() => expect(markDone().classList.contains("or-btn--primary")).toBe(true));
    await user.click(markDone());
    await waitFor(() =>
      expect(seen.some((r) => r.method === "POST" && r.path === `${DETAIL_PATH}/done`)).toBe(true),
    );
  });

  it("Mark done is primary when there are no tasks to check", async () => {
    detail = storyDetail({ description: "Renew the domain." });
    renderChecklist({ markDone: true });
    const markDone = await screen.findByRole("button", { name: MARK_DONE });
    expect(markDone.classList.contains("or-btn--primary")).toBe(true);
  });
});

describe("plainTaskText", () => {
  it("keeps a link's text and drops emphasis and code marks", () => {
    expect(plainTaskText("Read [the runbook](https://x.test/r) and run `make` **now**")).toBe(
      "Read the runbook and run make now",
    );
  });
});
