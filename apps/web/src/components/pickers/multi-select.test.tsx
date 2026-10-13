// @vitest-environment jsdom
import "./test-dom";
import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Field } from "@iamthemcmaster/ui";
import { describe, expect, it, vi } from "vitest";
import {
  MULTI_SELECT_RENDER_LIMIT,
  MultiSelect,
  type MultiSelectOption,
  type MultiSelectProps,
} from "./multi-select";

const HARNESSES: MultiSelectOption[] = [
  { value: "h1", label: "build-01", hint: "linux" },
  { value: "h2", label: "build-02", hint: "linux" },
  { value: "h3", label: "mac-mini", hint: "darwin" },
  { value: "h4", label: "gpu-box", hint: "linux" },
  { value: "h5", label: "spare", hint: "linux" },
];

function Harness({
  initial = [],
  onChange,
  ...props
}: Partial<Omit<MultiSelectProps, "value">> & { initial?: string[] }) {
  const [value, setValue] = React.useState(initial);
  return (
    <Field label="Pinned harnesses">
      <MultiSelect
        {...(props.onSearch ? {} : { options: HARNESSES })}
        {...props}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
    </Field>
  );
}

const trigger = () => screen.getByRole("combobox", { name: /^Pinned harnesses/ });
const chips = () =>
  within(screen.queryByRole("list", { name: "Selected" }) ?? document.createElement("ul"))
    .queryAllByRole("listitem")
    .map((item) => item.textContent);
const optionTexts = () => screen.getAllByRole("option").map((option) => option.textContent);

describe("MultiSelect", () => {
  it("is named by its Field and its summary", () => {
    render(<Harness initial={["h1"]} />);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().id).toBe(screen.getByText("Pinned harnesses").closest("label")?.htmlFor);
    expect(chips()).toEqual(["build-01"]);
  });

  it("lists the selected options first, then the rest, and toggles on click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={["h3"]} onChange={onChange} />);

    await user.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const selectedGroup = screen.getByRole("group", { name: "Selected" });
    expect(within(selectedGroup).getAllByRole("option")[0]?.textContent).toContain("mac-mini");
    expect(optionTexts()[0]).toContain("mac-mini");

    await user.click(screen.getByRole("option", { name: /build-02/ }));
    expect(onChange).toHaveBeenLastCalledWith(["h3", "h2"]);
    expect(screen.getByText("Added build-02", { selector: "[role=status]" })).toBeTruthy();

    await user.click(screen.getByRole("option", { name: /mac-mini, selected/ }));
    expect(onChange).toHaveBeenLastCalledWith(["h2"]);
    expect(chips()).toEqual(["build-02"]);
  });

  it("searches by label and hint", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.keyboard("darwin");
    expect(optionTexts()).toEqual([expect.stringContaining("mac-mini")]);
    await user.clear(screen.getByRole("combobox", { name: "Search options" }));
    await user.keyboard("nothing-like-this");
    expect(screen.getByText("No matching options.")).toBeTruthy();
  });

  it("is keyboard-operable and announces changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.tab();
    expect(document.activeElement).toBe(trigger());
    await user.keyboard("{Enter}");
    // The search box takes focus; arrows move through the list and Enter toggles.
    expect(document.activeElement?.getAttribute("placeholder")).toBe("Search…");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["h2"]);
    expect(screen.getByText("Added build-02", { selector: "[role=status]" })).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());

    // The chips come before the trigger.
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove build-02" }));
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.getByText("Removed build-02", { selector: "[role=status]" })).toBeTruthy();
  });

  it("collapses the chips to “N selected” past maxChips", () => {
    render(<Harness initial={["h1", "h2", "h3", "h4"]} maxChips={3} />);
    expect(chips()).toEqual([]);
    expect(trigger().textContent).toBe("4 selected");
    expect(trigger().getAttribute("aria-labelledby")?.split(" ")).toHaveLength(2);
  });

  it("keeps a saved value that isn't an option, warns about it, and never offers it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={["h1", "gone"]} onChange={onChange} />);

    const remove = screen.getByRole("button", { name: "Remove gone" });
    expect(remove.parentElement?.textContent).toContain("not available");
    expect(screen.getByText(/“gone” is not available/)).toBeTruthy();

    await user.click(trigger());
    expect(optionTexts().some((text) => text?.includes("gone"))).toBe(false);
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Remove gone" }));
    expect(onChange).toHaveBeenLastCalledWith(["h1"]);
    expect(screen.queryByText(/is not available/)).toBeNull();
  });

  it("stays responsive with 500 options: renders a bounded list and searches all of them", async () => {
    const user = userEvent.setup();
    const options = Array.from({ length: 500 }, (_, i) => ({
      value: `r${i}`,
      label: `repository-${String(i).padStart(3, "0")}`,
    }));
    render(<Harness options={options} initial={["r7"]} />);

    // A wall-clock bound flakes under a loaded test run; the render cap is what keeps it fast.
    await user.click(trigger());
    expect(screen.getAllByRole("option")).toHaveLength(MULTI_SELECT_RENDER_LIMIT + 1);
    expect(
      screen.getByText(`Showing ${MULTI_SELECT_RENDER_LIMIT} of 499. Search to narrow the list.`),
    ).toBeTruthy();
    await user.keyboard("repository-49");
    expect(optionTexts()).toHaveLength(10);
  });

  it("searches asynchronously with onSearch and keeps labels of chosen results", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn(async (query: string) =>
      HARNESSES.filter((option) => option.label.includes(query)),
    );
    const onChange = vi.fn();
    render(
      <Harness
        onSearch={onSearch}
        selectedOptions={[HARNESSES[0]!]}
        initial={["h1"]}
        onChange={onChange}
      />,
    );
    expect(chips()).toEqual(["build-01"]);

    await user.click(trigger());
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith(""));
    await user.keyboard("mac");
    await waitFor(() => expect(onSearch).toHaveBeenLastCalledWith("mac"));
    await user.click(await screen.findByRole("option", { name: /mac-mini/ }));
    expect(onChange).toHaveBeenLastCalledWith(["h1", "h3"]);
    await user.keyboard("{Escape}");
    expect(chips()).toEqual(["build-01", "mac-mini"]);
  });

  it("says when a search fails", async () => {
    const user = userEvent.setup();
    render(<Harness onSearch={() => Promise.reject(new Error("down"))} />);
    await user.click(trigger());
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Couldn't load options. Try again.",
    );
  });
});
