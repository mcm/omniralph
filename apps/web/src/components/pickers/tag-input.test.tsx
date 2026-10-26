// @vitest-environment jsdom
import "./test-dom";
import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Field } from "@iamthemcmaster/ui";
import { describe, expect, it, vi } from "vitest";
import { TAG_INPUT_RENDER_LIMIT, TagInput, type TagInputProps } from "./tag-input";

const LABELS = ["Bug", "Feature", "Chore", "Docs"];

function Agent({
  initial = [],
  onChange,
  ...props
}: Partial<Omit<TagInputProps, "value">> & { initial?: string[] }) {
  const [value, setValue] = React.useState(initial);
  return (
    <Field label="Labels" description="Issues with these labels are picked up.">
      <TagInput
        options={LABELS}
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

const input = () => screen.getByRole("combobox", { name: "Labels" });
const chips = () =>
  within(screen.queryByRole("list", { name: "Selected" }) ?? document.createElement("ul"))
    .queryAllByRole("listitem")
    .map((item) => item.textContent);

describe("TagInput", () => {
  it("is named by its Field and carries the Field's description and error wiring", () => {
    render(
      <Field label="Labels" description="Picked up." error="Choose at least one label.">
        <TagInput value={[]} onChange={() => {}} options={LABELS} />
      </Field>,
    );
    const box = input();
    expect(box).toHaveProperty("id", screen.getByText("Labels").closest("label")?.htmlFor);
    expect(box.getAttribute("aria-invalid")).toBe("true");
    const described = box.getAttribute("aria-describedby") ?? "";
    expect(described.split(" ").map((id) => document.getElementById(id)?.textContent)).toEqual(
      expect.arrayContaining(["Picked up.", "Choose at least one label."]),
    );
  });

  it("filters the options as you type and adds one on click, in order", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Agent initial={["Docs"]} onChange={onChange} />);

    await user.type(input(), "fe");
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Feature"]);

    await user.click(options[0]!);
    expect(onChange).toHaveBeenLastCalledWith(["Docs", "Feature"]);
    expect(chips()).toEqual(["Docs", "Feature"]);
    expect(input()).toHaveProperty("value", "");
    expect(screen.getByRole("status").textContent).toBe("Added Feature");
  });

  it("never offers a value that is already selected", async () => {
    const user = userEvent.setup();
    render(<Agent initial={["Bug", "Docs"]} />);
    await user.click(input());
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Feature",
      "Chore",
    ]);
  });

  it("is keyboard-operable: arrows move, Enter adds, Backspace on an empty query removes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Agent onChange={onChange} />);

    await user.tab();
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{ArrowDown}");
    const active = document.getElementById(input().getAttribute("aria-activedescendant") ?? "");
    expect(active?.textContent).toBe("Feature");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["Feature"]);

    await user.keyboard("bu{Enter}");
    expect(chips()).toEqual(["Feature", "Bug"]);

    await user.keyboard("{Backspace}");
    expect(chips()).toEqual(["Feature"]);
    expect(screen.getByRole("status").textContent).toBe("Removed Bug");

    await user.keyboard("{Escape}");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("removes a chip with its accessible remove button and keeps focus in the field", async () => {
    const user = userEvent.setup();
    render(<Agent initial={["Bug", "Chore"]} />);
    await user.click(screen.getByRole("button", { name: "Remove Bug" }));
    expect(chips()).toEqual(["Chore"]);
    expect(document.activeElement).toBe(input());
  });

  it("adds typed text with allowCustom", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Agent allowCustom onChange={onChange} />);

    await user.type(input(), "Backend{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["Backend"]);

    // Typed text that matches an option adds the option's spelling.
    await user.type(input(), "chore{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["Backend", "Chore"]);
  });

  it("only adds options without allowCustom", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Agent onChange={onChange} />);

    await user.type(input(), "Backend{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matching options.")).toBeTruthy();
  });

  it("stops adding at max", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Agent initial={["Bug"]} max={1} onChange={onChange} />);
    await user.type(input(), "fe{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("Up to 1 value. Remove one to add another.")).toBeTruthy();
  });

  it("keeps a saved value that isn't an option, warns about it, and never offers it", async () => {
    const user = userEvent.setup();
    render(<Agent initial={["Bug", "Old label"]} allowCustom={false} />);

    const stale = screen.getByRole("button", { name: "Remove Old label" }).parentElement!;
    expect(stale.textContent).toContain("not available");
    const note = screen.getByText(/“Old label” is not available/);
    expect(input().getAttribute("aria-describedby")).toContain(note.closest("p")!.id);

    await user.type(input(), "old");
    expect(screen.queryAllByRole("option")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Remove Old label" }));
    expect(chips()).toEqual(["Bug"]);
    expect(screen.queryByText(/is not available/)).toBeNull();
  });

  it("renders a bounded number of options from a long list", async () => {
    const user = userEvent.setup();
    const options = Array.from({ length: 500 }, (_, i) => `label-${i}`);
    render(<Agent options={options} />);
    await user.click(input());
    expect(screen.getAllByRole("option")).toHaveLength(TAG_INPUT_RENDER_LIMIT);
    expect(
      screen.getByText(`Showing ${TAG_INPUT_RENDER_LIMIT} of 500. Type to narrow the list.`),
    ).toBeTruthy();
    await user.type(input(), "label-499");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "label-499",
    ]);
  });
});
