// @vitest-environment jsdom
import type * as OmniralphUi from "@omniralph/ui";
import { useQuery, QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { CurrentUserProvider } from "./current-user";
import { createTestQueryClient, TEST_ORGANIZATION_ID, testUser } from "./query-test-utils";
import { UnsavedChangesProvider } from "./unsaved-changes";
import { useStagedCard, type StagedChange } from "./use-staged-card";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));
const nav = vi.hoisted(() => ({ router: { push: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => nav.router }));

interface Thing {
  name: string;
  enabled: boolean;
}

const KEY = queryKeys(TEST_ORGANIZATION_ID).agents.detail("thing");

// Trailing spaces don't count as a change (like a list put back in another order).
const toChanges = (saved: Thing, draft: Thing): StagedChange[] => [
  ...(draft.name.trimEnd() !== saved.name
    ? [{ id: "name", label: "Name", from: saved.name, to: draft.name, effect: "Renames it." }]
    : []),
  ...(draft.enabled !== saved.enabled
    ? [{ id: "enabled", label: "Enabled", effect: draft.enabled ? "Starts it." : "Stops it." }]
    : []),
];

let request: ReturnType<typeof vi.fn<(draft: Thing) => Promise<{ card: Thing }>>>;
let fetches: number;

interface Options {
  confirm?: boolean;
  conflict?: boolean;
}

function Thing(options: Options) {
  const saved = useQuery<Thing>({
    queryKey: KEY,
    queryFn: async () => {
      fetches += 1;
      return { name: "alpha", enabled: true };
    },
    staleTime: Infinity,
  });
  if (!saved.data) return null;
  return <ThingCard saved={saved.data} {...options} />;
}

function ThingCard({ saved, confirm, conflict }: Options & { saved: Thing }) {
  const card = useStagedCard<Thing, { card: Thing }>({
    label: "Thing",
    anchorId: "thing",
    saved,
    toChanges,
    save: {
      request: (draft) => request(draft),
      applyResult: (result, cache) => cache.set<Thing>(KEY, () => result.card),
    },
    needsConfirm: confirm
      ? (changes) => changes.filter((change) => change.id === "enabled")
      : undefined,
    conflictMessage: conflict ? "Someone else changed this thing." : undefined,
  });
  return (
    <section id="thing">
      <label>
        Name
        <input value={card.draft.name} onChange={(e) => card.set("name", e.target.value)} />
      </label>
      <label>
        Enabled
        <input
          type="checkbox"
          checked={card.draft.enabled}
          onChange={(e) => card.set("enabled", e.target.checked)}
        />
      </label>
      <ul aria-label="Changes">
        {card.changes.map((change) => (
          <li key={change.id}>
            {change.label}: {change.effect}
          </li>
        ))}
      </ul>
      {card.error ? <p role="alert">{card.error}</p> : null}
      {card.conflict ? (
        <p>
          Conflict: {card.conflict.message}
          <button type="button" onClick={card.conflict.onKeepEditing}>
            Keep editing
          </button>
        </p>
      ) : null}
      {card.fieldErrors.name ? <p>Name error: {card.fieldErrors.name}</p> : null}
      <button type="button" onClick={card.submit}>
        Save
      </button>
      <button type="button" onClick={card.discard}>
        Discard
      </button>
      <a href="/elsewhere">Elsewhere</a>
      {card.dialog}
    </section>
  );
}

function renderThing(options: Options = {}) {
  const client: QueryClient = createTestQueryClient();
  render(
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={client}>
        <UnsavedChangesProvider>
          <Thing {...options} />
        </UnsavedChangesProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
  return client;
}

const nameInput = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Name" });
const enabledBox = () => screen.getByRole<HTMLInputElement>("checkbox", { name: "Enabled" });
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

describe("useStagedCard", () => {
  it("seeds the draft from the saved values, with nothing pending", async () => {
    renderThing();
    expect((await screen.findByRole("textbox", { name: "Name" })).getAttribute("value")).toBe(
      "alpha",
    );
    expect(enabledBox().checked).toBe(true);
    expect(changeItems()).toEqual([]);
  });

  it("lists each edit with its effect, and un-stages an edit set back", async () => {
    renderThing();
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Name" });
    await user.clear(nameInput());
    await user.type(nameInput(), "beta");
    await user.click(enabledBox());
    expect(changeItems()).toEqual(["Name: Renames it.", "Enabled: Stops it."]);
    await user.click(enabledBox());
    expect(changeItems()).toEqual(["Name: Renames it."]);
  });

  it("follows a live update in untouched fields and keeps the edited ones", async () => {
    const client = renderThing();
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Name" });
    await user.clear(nameInput());
    await user.type(nameInput(), "mine");
    act(() => client.setQueryData<Thing>(KEY, { name: "theirs", enabled: false }));
    await waitFor(() => expect(enabledBox().checked).toBe(false));
    expect(nameInput().value).toBe("mine");
    expect(changeItems()).toEqual(["Name: Renames it."]);
  });

  it("flags another save under the draft as a conflict, when asked to", async () => {
    const client = renderThing({ conflict: true });
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Name" });
    await user.clear(nameInput());
    await user.type(nameInput(), "mine");
    expect(screen.queryByText(/Conflict:/)).toBeNull();

    act(() => client.setQueryData<Thing>(KEY, { name: "theirs", enabled: false }));
    expect(await screen.findByText(/Conflict: Someone else changed this thing\./)).toBeTruthy();
    // Save is refused until the user chooses.
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(request).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText(/Conflict:/)).toBeNull();
    expect(nameInput().value).toBe("mine");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ name: "mine", enabled: false }));
    // Saved: a later update is no conflict.
    act(() => client.setQueryData<Thing>(KEY, { name: "later", enabled: true }));
    await waitFor(() => expect(nameInput().value).toBe("later"));
    expect(screen.queryByText(/Conflict:/)).toBeNull();
  });

  it("drops the conflict and the edits on Discard", async () => {
    const client = renderThing({ conflict: true });
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Name" });
    await user.type(nameInput(), "2");
    act(() => client.setQueryData<Thing>(KEY, { name: "theirs", enabled: true }));
    expect(await screen.findByText(/Conflict:/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText(/Conflict:/)).toBeNull();
    expect(nameInput().value).toBe("theirs");
  });

  it("never flags a conflict without a conflict message", async () => {
    const client = renderThing();
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Name" });
    await user.type(nameInput(), "2");
    act(() => client.setQueryData<Thing>(KEY, { name: "theirs", enabled: true }));
    await waitFor(() => expect(nameInput().value).toBe("alpha2"));
    expect(screen.queryByText(/Conflict:/)).toBeNull();
  });

  it("discards every edit", async () => {
    renderThing();
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Name" });
    await user.type(nameInput(), "-x");
    await user.click(enabledBox());
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(nameInput().value).toBe("alpha");
    expect(enabledBox().checked).toBe(true);
    expect(changeItems()).toEqual([]);
  });

  it("saves the whole draft once, writes the answer into the cache and refetches nothing", async () => {
    const client = renderThing();
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Name" });
    expect(fetches).toBe(1);
    await user.type(nameInput(), "-2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(changeItems()).toEqual([]));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ name: "alpha-2", enabled: true });
    expect(client.getQueryData(KEY)).toEqual({ name: "alpha-2", enabled: true });
    expect(nameInput().value).toBe("alpha-2");
    expect(ui.toast).toHaveBeenCalledWith("Saved");
    expect(fetches).toBe(1);
    expect(client.getQueryState(KEY)!.isInvalidated).toBe(false);
  });

  it("sends nothing without changes", async () => {
    renderThing();
    await screen.findByRole("textbox", { name: "Name" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
    expect(request).not.toHaveBeenCalled();
  });

  it("asks first when changes need confirming, then saves", async () => {
    renderThing({ confirm: true });
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Name" });
    await user.click(enabledBox());
    await user.type(nameInput(), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Save Thing changes?" });
    expect(dialog.textContent).toContain("Enabled Stops it.");
    expect(dialog.textContent).not.toContain("Renames it.");
    expect(request).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith({ name: "alpha!", enabled: false });
  });

  it("saves nothing when the confirmation is cancelled, keeping the edits", async () => {
    renderThing({ confirm: true });
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Name" });
    await user.click(enabledBox());
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Save Thing changes?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(request).not.toHaveBeenCalled();
    expect(changeItems()).toEqual(["Enabled: Stops it."]);
  });

  it("saves without asking when no change needs confirming", async () => {
    renderThing({ confirm: true });
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Name" });
    await user.type(nameInput(), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("keeps the edits and shows the refusal and its field errors when the save fails", async () => {
    request.mockRejectedValue(
      new ApiError("Fix the errors below.", 400, "validation", { name: "Too long." }),
    );
    renderThing();
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Name" });
    await user.type(nameInput(), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Fix the errors below.");
    expect(screen.getByText("Name error: Too long.")).toBeTruthy();
    expect(changeItems()).toEqual(["Name: Renames it."]);
    await user.type(nameInput(), "?");
    expect(screen.queryByRole("alert")).toBeNull();
  });

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

  it("isn't dirty for an edit with no change to save, and doesn't ask before leaving", async () => {
    renderThing();
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Name" });
    await user.type(nameInput(), " ");
    expect(nameInput().value).toBe("alpha ");
    expect(changeItems()).toEqual([]);
    const link = screen.getByRole("link", { name: "Elsewhere" });
    link.addEventListener("click", (event) => event.preventDefault());
    await user.click(link);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(request).not.toHaveBeenCalled();
  });
});
