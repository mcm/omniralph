import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from "./segmented-control.js";

const options: SegmentedOption[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

function setup(props: Partial<Omit<SegmentedControlProps, "aria-label" | "aria-labelledby">> = {}) {
  const user = userEvent.setup();
  const onValueChange = vi.fn();
  render(
    <>
      <button type="button">Before</button>
      <SegmentedControl
        aria-label="Period"
        options={options}
        defaultValue="week"
        onValueChange={onValueChange}
        {...props}
      />
    </>,
  );
  return { user, onValueChange };
}

const radio = (name: string) => screen.getByRole("radio", { name });
const checked = () =>
  screen.getAllByRole("radio").filter((el) => el.getAttribute("aria-checked") === "true");

describe("SegmentedControl", () => {
  it("renders a named radiogroup of radios with the selected one checked", () => {
    setup();
    expect(screen.getByRole("radiogroup", { name: "Period" })).toBeTruthy();
    expect(screen.getAllByRole("radio").map((el) => el.textContent)).toEqual([
      "Day",
      "Week",
      "Month",
      "Year",
    ]);
    expect(checked()).toEqual([radio("Week")]);
  });

  it("draws a fail-toned option's label in coral, checked or not", () => {
    setup({ options: [...options.slice(0, 3), { value: "year", label: "Year", tone: "fail" }] });
    expect(radio("Year").className).toBe("or-seg__option or-seg__option--fail");
    expect(radio("Day").className).toBe("or-seg__option");
  });

  it("is a single tab stop on the selected option", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Before" }));
    await user.tab();
    expect(document.activeElement).toBe(radio("Week"));
    await user.tab();
    expect(document.activeElement).toBe(document.body);
  });

  it("calls onValueChange when an option is clicked", async () => {
    const { user, onValueChange } = setup();
    await user.click(radio("Month"));
    expect(onValueChange).toHaveBeenCalledWith("month");
    expect(checked()).toEqual([radio("Month")]);
  });

  it.each([
    ["{ArrowRight}", "Month"],
    ["{ArrowDown}", "Month"],
    ["{ArrowLeft}", "Day"],
    ["{ArrowUp}", "Day"],
    ["{Home}", "Day"],
    ["{End}", "Year"],
  ])("%s moves focus to and selects %s", async (key, expected) => {
    const { user, onValueChange } = setup();
    radio("Week").focus();
    await user.keyboard(key);
    expect(document.activeElement).toBe(radio(expected));
    expect(checked()).toEqual([radio(expected)]);
    expect(onValueChange).toHaveBeenCalledWith(expected.toLowerCase());
  });

  it("wraps around at either end", async () => {
    const { user } = setup({ defaultValue: "year" });
    radio("Year").focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(radio("Day"));
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(radio("Year"));
  });

  it("skips disabled options", async () => {
    const { user } = setup({
      options: [options[0]!, { ...options[1]!, disabled: true }, options[2]!],
      defaultValue: "day",
    });
    radio("Day").focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(radio("Month"));
  });

  it("stays on the controlled value until the parent changes it", async () => {
    const { user, onValueChange } = setup({ value: "day", defaultValue: undefined });
    await user.click(radio("Year"));
    expect(onValueChange).toHaveBeenCalledWith("year");
    expect(checked()).toEqual([radio("Day")]);
  });

  it("puts the tab stop on the first option when nothing is selected", async () => {
    const { user } = setup({ defaultValue: undefined });
    await user.click(screen.getByRole("button", { name: "Before" }));
    await user.tab();
    expect(document.activeElement).toBe(radio("Day"));
    expect(checked()).toEqual([]);
  });
});
