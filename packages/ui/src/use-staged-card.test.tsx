import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STAGED_SAVE_FAILED, useStagedCard, type StagedChange } from "./use-staged-card.js";

interface Thing {
  name: string;
  enabled: boolean;
}

// Trailing spaces don't count as a change (like a list put back in another order).
const toChanges = (saved: Thing, draft: Thing): StagedChange[] => [
  ...(draft.name.trimEnd() !== saved.name
    ? [{ id: "name", label: "Name", from: saved.name, to: draft.name, effect: "Renames it." }]
    : []),
  ...(draft.enabled !== saved.enabled
    ? [{ id: "enabled", label: "Enabled", effect: draft.enabled ? "Starts it." : "Stops it." }]
    : []),
];

let save: ReturnType<typeof vi.fn<(draft: Thing) => Promise<Thing>>>;
let onDirtyChange: ReturnType<typeof vi.fn<(dirty: boolean) => void>>;
/** Replaces the saved values, as a live update (or the save's answer) does. */
let setSaved: (next: Thing) => void;

interface Options {
  confirm?: boolean;
  conflict?: boolean;
}

function Thing(options: Options) {
  const [saved, set] = React.useState<Thing>({ name: "alpha", enabled: true });
  setSaved = set;
  return <ThingCard saved={saved} {...options} />;
}

function ThingCard({ saved, confirm, conflict }: Options & { saved: Thing }) {
  const card = useStagedCard<Thing, Thing>({
    label: "Thing",
    saved,
    toChanges,
    save: async (draft) => {
      const result = await save(draft);
      // The save writes its answer where the view reads it.
      setSaved(result);
      return result;
    },
    needsConfirm: confirm
      ? (changes) => changes.filter((change) => change.id === "enabled")
      : undefined,
    conflictMessage: conflict ? "Someone else changed this thing." : undefined,
    onDirtyChange,
  });
  return (
    <section>
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
      {card.saving ? <p>Saving</p> : null}
      {card.error ? <p role="alert">{card.error}</p> : null}
      {card.errorCode ? <p>Code: {card.errorCode}</p> : null}
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
      {card.dialog}
    </section>
  );
}

function renderThing(options: Options = {}) {
  render(<Thing {...options} />);
}

const nameInput = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Name" });
const enabledBox = () => screen.getByRole<HTMLInputElement>("checkbox", { name: "Enabled" });
const changeItems = () =>
  within(screen.getByRole("list", { name: "Changes" }))
    .queryAllByRole("listitem")
    .map((item) => item.textContent);

class SaveFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly fieldErrors: Record<string, string>,
  ) {
    super(message);
  }
}

beforeEach(() => {
  save = vi.fn(async (draft: Thing) => draft);
  onDirtyChange = vi.fn();
});

describe("useStagedCard", () => {
  it("seeds the draft from the saved values, with nothing pending", () => {
    renderThing();
    expect(nameInput().value).toBe("alpha");
    expect(enabledBox().checked).toBe(true);
    expect(changeItems()).toEqual([]);
    expect(onDirtyChange.mock.calls).toEqual([[false]]);
  });

  it("lists each edit with its effect, and un-stages an edit set back", async () => {
    renderThing();
    const user = userEvent.setup();
    await user.clear(nameInput());
    await user.type(nameInput(), "beta");
    await user.click(enabledBox());
    expect(changeItems()).toEqual(["Name: Renames it.", "Enabled: Stops it."]);
    await user.click(enabledBox());
    expect(changeItems()).toEqual(["Name: Renames it."]);
  });

  it("follows a live update in untouched fields and keeps the edited ones", async () => {
    renderThing();
    const user = userEvent.setup();
    await user.clear(nameInput());
    await user.type(nameInput(), "mine");
    act(() => setSaved({ name: "theirs", enabled: false }));
    expect(enabledBox().checked).toBe(false);
    expect(nameInput().value).toBe("mine");
    expect(changeItems()).toEqual(["Name: Renames it."]);
  });

  it("flags another save under the draft as a conflict, when asked to", async () => {
    renderThing({ conflict: true });
    const user = userEvent.setup();
    await user.clear(nameInput());
    await user.type(nameInput(), "mine");
    expect(screen.queryByText(/Conflict:/)).toBeNull();

    act(() => setSaved({ name: "theirs", enabled: false }));
    expect(screen.getByText(/Conflict: Someone else changed this thing\./)).toBeTruthy();
    // Save is refused until the user chooses.
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText(/Conflict:/)).toBeNull();
    expect(nameInput().value).toBe("mine");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ name: "mine", enabled: false }));
    await waitFor(() => expect(changeItems()).toEqual([]));
    // Saved: a later update is no conflict.
    act(() => setSaved({ name: "later", enabled: true }));
    expect(nameInput().value).toBe("later");
    expect(screen.queryByText(/Conflict:/)).toBeNull();
  });

  it("drops the conflict and the edits on Discard", async () => {
    renderThing({ conflict: true });
    const user = userEvent.setup();
    await user.type(nameInput(), "2");
    act(() => setSaved({ name: "theirs", enabled: true }));
    expect(screen.getByText(/Conflict:/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText(/Conflict:/)).toBeNull();
    expect(nameInput().value).toBe("theirs");
  });

  it("never flags a conflict without a conflict message", async () => {
    renderThing();
    const user = userEvent.setup();
    await user.type(nameInput(), "2");
    act(() => setSaved({ name: "theirs", enabled: true }));
    expect(nameInput().value).toBe("alpha2");
    expect(screen.queryByText(/Conflict:/)).toBeNull();
  });

  it("discards every edit", async () => {
    renderThing();
    const user = userEvent.setup();
    await user.type(nameInput(), "-x");
    await user.click(enabledBox());
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(nameInput().value).toBe("alpha");
    expect(enabledBox().checked).toBe(true);
    expect(changeItems()).toEqual([]);
  });

  it("saves the whole draft once and shows the saved state", async () => {
    let finish!: (thing: Thing) => void;
    save.mockImplementation(() => new Promise<Thing>((resolve) => (finish = resolve)));
    renderThing();
    const user = userEvent.setup();
    await user.type(nameInput(), "-2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Saving")).toBeTruthy();
    // A second Save while one is in flight sends nothing.
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ name: "alpha-2", enabled: true });

    await act(async () => finish({ name: "alpha-2", enabled: true }));
    expect(screen.queryByText("Saving")).toBeNull();
    expect(changeItems()).toEqual([]);
    expect(nameInput().value).toBe("alpha-2");
  });

  it("keeps edits made while the save was in flight", async () => {
    let finish!: (thing: Thing) => void;
    save.mockImplementation(() => new Promise<Thing>((resolve) => (finish = resolve)));
    renderThing();
    const user = userEvent.setup();
    await user.type(nameInput(), "-2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(enabledBox());
    await act(async () => finish({ name: "alpha-2", enabled: true }));
    expect(changeItems()).toEqual(["Enabled: Stops it."]);
  });

  it("sends nothing without changes", async () => {
    renderThing();
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
    expect(save).not.toHaveBeenCalled();
  });

  it("asks first when changes need confirming, then saves", async () => {
    renderThing({ confirm: true });
    const user = userEvent.setup();
    await user.click(enabledBox());
    await user.type(nameInput(), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Save Thing changes?" });
    expect(dialog.textContent).toContain("Enabled Stops it.");
    expect(dialog.textContent).not.toContain("Renames it.");
    expect(save).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({ name: "alpha!", enabled: false });
  });

  it("saves nothing when the confirmation is cancelled, keeping the edits", async () => {
    renderThing({ confirm: true });
    const user = userEvent.setup();
    await user.click(enabledBox());
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Save Thing changes?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(save).not.toHaveBeenCalled();
    expect(changeItems()).toEqual(["Enabled: Stops it."]);
  });

  it("saves without asking when no change needs confirming", async () => {
    renderThing({ confirm: true });
    const user = userEvent.setup();
    await user.type(nameInput(), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("keeps the edits and shows the refusal, its code and field errors when the save fails", async () => {
    save.mockRejectedValue(
      new SaveFailure("Fix the errors below.", "validation", { name: "Too long." }),
    );
    renderThing();
    const user = userEvent.setup();
    await user.type(nameInput(), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Fix the errors below.");
    expect(screen.getByText("Code: validation")).toBeTruthy();
    expect(screen.getByText("Name error: Too long.")).toBeTruthy();
    expect(screen.queryByText("Saving")).toBeNull();
    expect(changeItems()).toEqual(["Name: Renames it."]);
    await user.type(nameInput(), "?");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Name error: Too long.")).toBeNull();
  });

  it("shows a generic refusal when the save fails without a message", async () => {
    save.mockRejectedValue(new Error(""));
    renderThing();
    const user = userEvent.setup();
    await user.type(nameInput(), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe(STAGED_SAVE_FAILED);
  });

  it("reports dirty as it changes, and clean once saved", async () => {
    renderThing();
    const user = userEvent.setup();
    await user.type(nameInput(), "!");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(onDirtyChange.mock.calls).toEqual([[false], [true], [false]]);
  });

  it("isn't dirty for an edit with no change to save", async () => {
    renderThing();
    const user = userEvent.setup();
    await user.type(nameInput(), " ");
    expect(nameInput().value).toBe("alpha ");
    expect(changeItems()).toEqual([]);
    expect(onDirtyChange.mock.calls).toEqual([[false]]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).not.toHaveBeenCalled();
  });
});
