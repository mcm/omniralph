import { IconCopy, IconTrash } from "@tabler/icons-react";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button.js";
import { Menu, orderMenuItems, type MenuItem } from "./menu.js";

const noop = () => {};

function renderMenu(items: MenuItem[]) {
  render(<Menu items={items} trigger={<Button>Actions</Button>} />);
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

  it("renders checkable choices as menuitemcheckbox with a check on the checked one", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const trigger = renderMenu([
      { label: "Acme", onSelect: noop, checked: true },
      { label: "Beta", onSelect, checked: false },
      "separator",
      { label: "New organization", href: "/onboarding" },
    ]);
    await user.click(trigger);
    const acme = await screen.findByRole("menuitemcheckbox", { name: "Acme", checked: true });
    expect(acme.querySelector(".or-menu__check svg")).not.toBeNull();
    const beta = screen.getByRole("menuitemcheckbox", { name: "Beta", checked: false });
    expect(beta.querySelector(".or-menu__check")).toBeNull();
    expect(screen.getByRole("menuitem", { name: "New organization" })).toBeTruthy();
    await user.click(beta);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("Menu header", () => {
  function renderWithHeader(onPick = vi.fn()) {
    const user = userEvent.setup();
    render(
      <Menu
        trigger={<Button>Account</Button>}
        header={
          <div>
            <span>Ada Lovelace</span>
            <button type="button" onClick={() => onPick("a")}>
              Alpha
            </button>
            <button type="button" onClick={() => onPick("b")}>
              Beta
            </button>
          </div>
        }
        items={[{ label: "Sign out", onSelect: noop }]}
      />,
    );
    return { user, trigger: screen.getByRole("button", { name: "Account" }) };
  }

  it("renders above the items and stays open when its controls are used", async () => {
    const onPick = vi.fn();
    const { user, trigger } = renderWithHeader(onPick);
    await user.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Ada Lovelace")).toBeTruthy();
    await user.click(within(menu).getByRole("button", { name: "Beta" }));
    expect(onPick).toHaveBeenCalledWith("b");
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("moves between the header's controls and the items with Tab and Shift+Tab", async () => {
    const { user, trigger } = renderWithHeader();
    trigger.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    const signOut = screen.getByRole("menuitem", { name: "Sign out" });
    expect(document.activeElement).toBe(signOut);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Alpha" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Beta" }));
    // Typing in the header doesn't jump to an item by typeahead.
    await user.keyboard("s");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Beta" }));
    await user.tab();
    expect(document.activeElement).toBe(signOut);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Beta" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("Menu groups and keepOpen", () => {
  it("labels consecutive items of a group, draws marks and stays open on keepOpen items", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const trigger = renderMenu([
      { label: "All", onSelect: noop },
      {
        label: "acme/api",
        onSelect,
        group: "Acme",
        keepOpen: true,
        mark: <svg data-testid="mark" />,
      },
      { label: "acme/web", onSelect: noop, group: "Acme" },
      { label: "beta/app", onSelect: noop, group: "Beta" },
    ]);
    await user.click(trigger);
    const acme = await screen.findByRole("group", { name: "Acme" });
    expect(
      within(acme)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["acme/api", "acme/web"]);
    expect(
      within(screen.getByRole("group", { name: "Beta" })).getByRole("menuitem").textContent,
    ).toBe("beta/app");
    expect(screen.getByTestId("mark").closest(".or-menu__mark")).not.toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "acme/api" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.getByRole("menu")).toBeTruthy();
  });
});

describe("Menu shortcut keys", () => {
  it("puts an item's key on it, and opens when told to", async () => {
    const { rerender } = render(
      <Menu
        open={false}
        items={[{ label: "Stop run", onSelect: noop, keyShortcuts: "X" }]}
        trigger={<Button>Actions</Button>}
      />,
    );
    expect(screen.queryByRole("menu")).toBeNull();
    rerender(
      <Menu
        open
        items={[{ label: "Stop run", onSelect: noop, keyShortcuts: "X" }]}
        trigger={<Button>Actions</Button>}
      />,
    );
    const item = await screen.findByRole("menuitem", { name: "Stop run" });
    expect(item.getAttribute("aria-keyshortcuts")).toBe("X");
    expect(item.textContent).toBe("Stop run");
  });
});
