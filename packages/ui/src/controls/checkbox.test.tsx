import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { Checkbox } from "./checkbox.js";

describe("Checkbox", () => {
  it("renders a native checkbox inside its label", () => {
    render(<Checkbox label="Include drafts" />);
    const box = screen.getByRole("checkbox", { name: "Include drafts" });
    expect(box.tagName).toBe("INPUT");
    expect(box).toHaveProperty("type", "checkbox");
    expect(box.closest("label")?.textContent).toBe("Include drafts");
  });

  it("can be named by aria-label without a visible label", () => {
    render(<Checkbox aria-label="Select acme/web" />);
    expect(screen.getByRole("checkbox", { name: "Select acme/web" })).toBeTruthy();
  });

  it("toggles by clicking the box or its label", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox label="Include drafts" onCheckedChange={onCheckedChange} />);
    const box = screen.getByRole("checkbox");
    await user.click(box);
    expect(box).toHaveProperty("checked", true);
    await user.click(screen.getByText("Include drafts"));
    expect(box).toHaveProperty("checked", false);
    expect(onCheckedChange.mock.calls).toEqual([[true], [false]]);
  });

  it("toggles with Space", async () => {
    const user = userEvent.setup();
    render(<Checkbox label="Include drafts" />);
    const box = screen.getByRole("checkbox");
    await user.tab();
    expect(document.activeElement).toBe(box);
    await user.keyboard(" ");
    expect(box).toHaveProperty("checked", true);
  });

  it("reflects the checked prop", () => {
    render(<Checkbox label="Include drafts" checked onChange={() => {}} />);
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", true);
  });

  it("sets the DOM indeterminate property and the mixed state", () => {
    const ref = createRef<HTMLInputElement>();
    const { rerender } = render(<Checkbox ref={ref} label="All repos" indeterminate />);
    const box = screen.getByRole("checkbox", { name: "All repos" });
    expect(ref.current).toBe(box);
    expect(box).toHaveProperty("indeterminate", true);
    expect(box.getAttribute("aria-checked")).toBe("mixed");
    rerender(<Checkbox ref={ref} label="All repos" />);
    expect(box).toHaveProperty("indeterminate", false);
    expect(box.hasAttribute("aria-checked")).toBe(false);
  });

  it("does not toggle when disabled", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox label="Include drafts" disabled onCheckedChange={onCheckedChange} />);
    const box = screen.getByRole("checkbox");
    expect(box).toHaveProperty("disabled", true);
    await user.click(screen.getByText("Include drafts"));
    expect(box).toHaveProperty("checked", false);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
