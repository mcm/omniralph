import { IconCopy, IconTrash } from "@tabler/icons-react";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button.js";
import { Menu, orderMenuItems, type MenuItem } from "./menu.js";

const noop = () => {};

function renderMenu(items: MenuItem[], disabled?: boolean) {
  render(<Menu items={items} trigger={<Button>Actions</Button>} disabled={disabled} />);
  return screen.getByRole("button", { name: "Actions" });
}

const labels = () => screen.getAllByRole("menuitem").map((item) => item.textContent);

describe("orderMenuItems", () => {
  it("moves destructive items last after a separator and drops stray separators", () => {
    const remove = { label: "Delete", onSelect: noop, destructive: true };
    const copy = { label: "Copy", onSelect: noop };
    const open = { label: "Open", href: "/x" };
    expect(
      orderMenuItems(["separator", remove, copy, "separator", "separator", open, "separator"]),
    ).toEqual([copy, "separator", open, "separator", remove]);
    expect(orderMenuItems([remove])).toEqual([remove]);
    expect(orderMenuItems([copy, "separator"])).toEqual([copy]);
  });
});

describe("Menu", () => {
  it.each(["{Enter}", " "])(
    "opens with %s on the trigger and focuses the first item",
    async (key) => {
      const user = userEvent.setup();
      const trigger = renderMenu([
        { label: "Copy ID", onSelect: noop },
        { label: "Rerun", onSelect: noop },
      ]);
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      trigger.focus();
      await user.keyboard(key);
      const menu = await screen.findByRole("menu");
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(labels()).toEqual(["Copy ID", "Rerun"]);
      expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Copy ID" }));
    },
  );

  it("moves between items with ArrowDown and ArrowUp, and Escape returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const trigger = renderMenu([
      { label: "Copy ID", onSelect: noop },
      { label: "Rerun", onSelect: noop },
      { label: "Cancel run", onSelect: noop },
    ]);
    trigger.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rerun" }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Cancel run" }));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rerun" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("renders destructive items last, after a separator, in the danger style", async () => {
    const user = userEvent.setup();
    const trigger = renderMenu([
      { label: "Delete repository", icon: IconTrash, onSelect: noop, destructive: true },
      { label: "Copy ID", icon: IconCopy, onSelect: noop },
      { label: "Settings", href: "/settings" },
    ]);
    await user.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(labels()).toEqual(["Copy ID", "Settings", "Delete repository"]);
    const children = Array.from(menu.children);
    const separator = within(menu).getByRole("separator");
    const destructive = screen.getByRole("menuitem", { name: "Delete repository" });
    expect(children.indexOf(separator)).toBe(children.length - 2);
    expect(children.at(-1)).toBe(destructive);
    expect(destructive.classList).toContain("or-menu__item--danger");
    expect(screen.getByRole("menuitem", { name: "Copy ID" }).classList).not.toContain(
      "or-menu__item--danger",
    );
  });

  it("runs onSelect and closes, and renders href items as links", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const trigger = renderMenu([
      { label: "Copy ID", onSelect },
      { label: "Settings", href: "/settings" },
    ]);
    await user.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Settings" }).getAttribute("href")).toBe(
      "/settings",
    );
    await user.click(screen.getByRole("menuitem", { name: "Copy ID" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("skips disabled items and never selects them", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const trigger = renderMenu([
      { label: "Copy ID", onSelect: noop },
      { label: "Rerun", onSelect, disabled: true },
      { label: "Open", onSelect: noop },
    ]);
    trigger.focus();
    await user.keyboard("{Enter}");
    const rerun = await screen.findByRole("menuitem", { name: "Rerun" });
    expect(rerun.getAttribute("aria-disabled")).toBe("true");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Open" }));
    await user.click(rerun);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not open while disabled", async () => {
    const user = userEvent.setup();
    const trigger = renderMenu([{ label: "Copy ID", onSelect: noop }], true);
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    await user.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
