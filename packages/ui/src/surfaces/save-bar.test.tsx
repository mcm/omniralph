import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SaveBar, type PendingChange } from "./save-bar.js";

const CHANGES: PendingChange[] = [
  {
    id: "branch",
    label: "Default branch",
    from: "main",
    to: "trunk",
    effect: "New runs start from trunk.",
  },
  { id: "labels", label: "Labels", to: "bug, ui" },
];

function setup(props: Partial<Parameters<typeof SaveBar>[0]> = {}) {
  const onSave = vi.fn();
  const onDiscard = vi.fn();
  const result = render(
    <SaveBar changes={CHANGES} onSave={onSave} onDiscard={onDiscard} {...props} />,
  );
  return { ...result, onSave, onDiscard };
}

describe("SaveBar", () => {
  it("renders nothing without changes", () => {
    const { container } = setup({ changes: [] });
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("lists each change with from → to and its effect", () => {
    setup();
    const region = screen.getByRole("region", { name: "Unsaved changes" });
    expect(within(region).getByText("2 unsaved changes")).toBeTruthy();
    const items = within(within(region).getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("Default branch")).toBeTruthy();
    expect(within(items[0]!).getByText("main")).toBeTruthy();
    expect(within(items[0]!).getByRole("img", { name: "to" })).toBeTruthy();
    expect(within(items[0]!).getByText("trunk")).toBeTruthy();
    expect(within(items[0]!).getByText("New runs start from trunk.")).toBeTruthy();
    expect(within(items[1]!).getByText("bug, ui")).toBeTruthy();
    expect(within(items[1]!).queryByRole("img")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("counts a single change in the singular", () => {
    setup({ changes: CHANGES.slice(0, 1) });
    expect(screen.getByText("1 unsaved change")).toBeTruthy();
  });

  it("draws Save solid (never primary) and Discard ghost, and calls back", async () => {
    const user = userEvent.setup();
    const { onSave, onDiscard } = setup();
    const save = screen.getByRole("button", { name: "Save" });
    const discard = screen.getByRole("button", { name: "Discard" });
    expect(save.className).toContain("or-btn--solid");
    expect(save.className).not.toContain("or-btn--primary");
    expect(discard.className).toContain("or-btn--ghost");
    await user.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
    await user.click(discard);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("names Save with saveLabel", () => {
    setup({ saveLabel: "Save 2 changes" });
    expect(screen.getByRole("button", { name: "Save 2 changes" })).toBeTruthy();
  });

  it("disables Save while saving", async () => {
    const user = userEvent.setup();
    const { onSave } = setup({ saving: true });
    const save = screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute("aria-busy")).toBe("true");
    await user.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("disables Discard while saving", async () => {
    const user = userEvent.setup();
    const { onDiscard } = setup({ saving: true });
    const discard = screen.getByRole("button", { name: "Discard" }) as HTMLButtonElement;
    expect(discard.disabled).toBe(true);
    await user.click(discard);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("shows the error in an alert", () => {
    setup({ error: "The repository is read-only." });
    expect(screen.getByRole("alert").textContent).toBe("The repository is read-only.");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("offers Discard or Keep editing instead of Save on a conflict", async () => {
    const onKeepEditing = vi.fn();
    const { onSave, onDiscard } = setup({
      conflict: { message: "Someone else changed these rules.", onKeepEditing },
    });
    expect(screen.getByRole("alert").textContent).toBe("Someone else changed these rules.");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(onKeepEditing).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });
});
