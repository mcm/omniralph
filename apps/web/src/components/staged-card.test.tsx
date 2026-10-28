// @vitest-environment jsdom
import type * as OmniralphUi from "@omniralph/ui";
import { useStagedCard, type StagedChange } from "@omniralph/ui";
import { useQuery, QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { CurrentUserProvider } from "./current-user";
import { createTestQueryClient, TEST_ORGANIZATION_ID, testUser } from "./query-test-utils";
import { useStagedSave, useUnsavedCard } from "./staged-card";
import { UnsavedChangesProvider } from "./unsaved-changes";
import { MUTATION_FAILED } from "./use-api-mutation";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));
const nav = vi.hoisted(() => ({ router: { push: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => nav.router }));

interface Thing {
  name: string;
}

const KEY = queryKeys(TEST_ORGANIZATION_ID).agents.detail("thing");

const toChanges = (saved: Thing, draft: Thing): StagedChange[] =>
  draft.name !== saved.name ? [{ id: "name", label: "Name", effect: "Renames it." }] : [];

let request: ReturnType<typeof vi.fn<(draft: Thing) => Promise<{ card: Thing }>>>;
let fetches: number;

function Thing() {
  const saved = useQuery<Thing>({
    queryKey: KEY,
    queryFn: async () => {
      fetches += 1;
      return { name: "alpha" };
    },
    staleTime: Infinity,
  });
  if (!saved.data) return null;
  return <ThingCard saved={saved.data} />;
}

function ThingCard({ saved }: { saved: Thing }) {
  const card = useStagedCard<Thing, { card: Thing }>({
    label: "Thing",
    saved,
    toChanges,
    save: useStagedSave({
      request: (draft) => request(draft),
      applyResult: (result, cache) => cache.set<Thing>(KEY, () => result.card),
    }),
    onDirtyChange: useUnsavedCard("Thing", "thing"),
  });
  return (
    <section id="thing">
      <label>
        Name
        <input value={card.draft.name} onChange={(e) => card.set("name", e.target.value)} />
      </label>
      <ul aria-label="Changes">
        {card.changes.map((change) => (
          <li key={change.id}>{change.label}</li>
        ))}
      </ul>
      {card.error ? <p role="alert">{card.error}</p> : null}
      {card.errorCode ? <p>Code: {card.errorCode}</p> : null}
      {card.fieldErrors.name ? <p>Name error: {card.fieldErrors.name}</p> : null}
      <button type="button" onClick={card.submit}>
        Save
      </button>
      <a href="/elsewhere">Elsewhere</a>
    </section>
  );
}

function renderThing() {
  const client: QueryClient = createTestQueryClient();
  render(
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={client}>
        <UnsavedChangesProvider>
          <Thing />
        </UnsavedChangesProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
  return client;
}

const nameInput = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Name" });
const changeItems = () =>
  within(screen.getByRole("list", { name: "Changes" }))
    .queryAllByRole("listitem")
    .map((item) => item.textContent);

beforeEach(() => {
  ui.toast.mockReset();
  nav.router.push.mockReset();
  request = vi.fn(async (draft: Thing) => ({ card: draft }));
  fetches = 0;
  window.history.replaceState(null, "", "/repos/thing");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useStagedSave", () => {
  it("saves once, writes the answer into the cache and refetches nothing", async () => {
    const client = renderThing();
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Name" });
    await user.type(nameInput(), "-2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(changeItems()).toEqual([]));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ name: "alpha-2" });
    expect(client.getQueryData(KEY)).toEqual({ name: "alpha-2" });
    expect(nameInput().value).toBe("alpha-2");
    expect(ui.toast).toHaveBeenCalledWith("Saved");
    expect(fetches).toBe(1);
    expect(client.getQueryState(KEY)!.isInvalidated).toBe(false);
  });

  it("shows the API's refusal, code and field errors, with the danger toast", async () => {
    request.mockRejectedValue(
      new ApiError("Fix the errors below.", 400, "validation", { name: "Too long." }),
    );
    renderThing();
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Name" });
    await user.type(nameInput(), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Fix the errors below.");
    expect(screen.getByText("Code: validation")).toBeTruthy();
    expect(screen.getByText("Name error: Too long.")).toBeTruthy();
    expect(ui.toast).toHaveBeenCalledWith("Fix the errors below.", { variant: "danger" });
    expect(changeItems()).toEqual(["Name"]);
  });

  it("shows the generic refusal for a failure that isn't the API's", async () => {
    request.mockRejectedValue(new TypeError("fetch failed"));
    renderThing();
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Name" });
    await user.type(nameInput(), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe(MUTATION_FAILED);
  });
});

describe("useUnsavedCard", () => {
  it("asks before leaving the page while dirty, and not once saved", async () => {
    renderThing();
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Name" });
    await user.type(nameInput(), "!");
    await user.click(screen.getByRole("link", { name: "Elsewhere" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Leave without saving?" });
    expect(dialog.textContent).toContain("1 card has unsaved changes: Thing.");
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(nav.router.push).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(changeItems()).toEqual([]));
    // A followed link (not intercepted) would navigate jsdom: stop it.
    const link = screen.getByRole("link", { name: "Elsewhere" });
    link.addEventListener("click", (event) => event.preventDefault());
    await user.click(link);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
