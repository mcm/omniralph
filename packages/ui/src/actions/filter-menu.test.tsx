import { IconRobot } from "@tabler/icons-react";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FilterMenu, filterMenuValue, type FilterOption } from "./filter-menu.js";

type Kind = "epic" | "request" | "review";
const KINDS: FilterOption<Kind>[] = [
  { value: "epic", label: "Epic", icon: IconRobot },
  { value: "request", label: "Request" },
  { value: "review", label: "Review" },
];

function ControlledFilterMenu({
  multiple = true,
  initial = [],
  onChange,
  options = KINDS,
}: {
  multiple?: boolean;
  initial?: Kind[];
  onChange?: (selected: Kind[]) => void;
  options?: FilterOption<Kind>[];
}) {
  const [selected, setSelected] = useState<Kind[]>(initial);
  return (
    <FilterMenu
      label="Kind"
      options={options}
      selected={selected}
      multiple={multiple}
      onChange={(next) => {
        setSelected(next);
        onChange?.(next);
      }}
    />
  );
}

const checkboxes = () =>
  screen.getAllByRole("menuitemcheckbox").map((item) => ({
    name: item.textContent,
    checked: item.getAttribute("aria-checked") === "true",
  }));

describe("filterMenuValue", () => {
  it("reads All without a choice, else the chosen labels in the options' order", () => {
    expect(filterMenuValue(KINDS, [])).toBe("All");
    expect(filterMenuValue(KINDS, ["review", "epic"])).toBe("Epic, Review");
  });
});

describe("FilterMenu", () => {
  it("names the button {label}: All, opens with Enter and focuses All", async () => {
    const user = userEvent.setup();
    render(<ControlledFilterMenu />);
    const button = screen.getByRole("button", { name: "Kind: All" });
    expect(button.className).toContain("or-filter");
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    button.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    expect(checkboxes()).toEqual([
      { name: "All", checked: true },
      { name: "Epic", checked: false },
      { name: "Request", checked: false },
      { name: "Review", checked: false },
    ]);
    expect(document.activeElement).toBe(screen.getByRole("menuitemcheckbox", { name: "All" }));
    expect(screen.getByRole("menuitem", { name: "Clear" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("moves with the arrow keys and toggles several values, staying open", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledFilterMenu onChange={onChange} />);
    screen.getByRole("button", { name: "Kind: All" }).focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemcheckbox", { name: "Epic" }));
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["epic"]);
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["epic", "review"]);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(
      checkboxes()
        .filter((c) => c.checked)
        .map((c) => c.name),
    ).toEqual(["Epic", "Review"]);
    // Toggling a chosen value off.
    await user.keyboard("{ArrowUp}{ArrowUp}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["review"]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Kind: Review" })).toBe(document.activeElement);
  });

  it("clears the choice with Clear or All, closing the menu", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledFilterMenu initial={["epic", "request"]} onChange={onChange} />);
    const button = screen.getByRole("button", { name: "Kind: Epic, Request" });
    await user.click(button);
    const clear = await screen.findByRole("menuitem", { name: "Clear" });
    expect(clear.getAttribute("aria-disabled")).toBeNull();
    await user.click(clear);
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Kind: All" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Kind: All" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Review" }));
    await user.keyboard("{Home}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("shortens many chosen values on the button but names them all", async () => {
    render(<ControlledFilterMenu initial={["epic", "request", "review"]} />);
    const button = screen.getByRole("button", { name: "Kind: Epic, Request, Review" });
    expect(button.textContent).toBe("Kind:Epic, Request +1");
  });

  it("picks one value and closes without multiple, with no Clear item", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledFilterMenu multiple={false} initial={["epic"]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Kind: Epic" }));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "Clear" })).toBeNull();
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Review" }));
    expect(onChange).toHaveBeenLastCalledWith(["review"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("groups options that carry a group and draws mark elements", async () => {
    const user = userEvent.setup();
    render(
      <ControlledFilterMenu
        options={[
          { value: "epic", label: "acme/api", group: "Acme", icon: <svg data-testid="gh" /> },
          { value: "request", label: "acme/web", group: "Acme" },
          { value: "review", label: "beta/app", group: "Beta" },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Kind: All" }));
    const acme = await screen.findByRole("group", { name: "Acme" });
    expect(
      within(acme)
        .getAllByRole("menuitemcheckbox")
        .map((item) => item.textContent),
    ).toEqual(["acme/api", "acme/web"]);
    expect(
      within(screen.getByRole("group", { name: "Beta" })).getByRole("menuitemcheckbox"),
    ).toBeTruthy();
    expect(within(acme).getByTestId("gh")).toBeTruthy();
  });
});
