import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RadioList } from "./radio-list.js";

const options = [
  { value: "web", label: "acme/web" },
  { value: "api", label: "acme/api" },
  { value: "docs", label: "acme/docs" },
];

describe("RadioList", () => {
  it("renders a radiogroup named by its visible label, with one named radio per option", () => {
    render(<RadioList label="Which repo?" options={options} />);
    const group = screen.getByRole("radiogroup", { name: "Which repo?" });
    expect(screen.getByText("Which repo?").id).toBe(group.getAttribute("aria-labelledby"));
    expect(group.getAttribute("aria-orientation")).toBe("vertical");
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    for (const { label } of options)
      expect(screen.getByRole("radio", { name: label })).toBeTruthy();
  });

  it("shows the aside beside the label, outside the group's name", () => {
    render(<RadioList label="Which repo?" aside="Expires in 2 hours" options={options} />);
    expect(screen.getByText("Expires in 2 hours")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Which repo?" })).toBeTruthy();
  });

  it("selects an option by clicking its label", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<RadioList label="Which repo?" options={options} onValueChange={onValueChange} />);
    await user.click(screen.getByText("acme/api"));
    expect(screen.getByRole("radio", { name: "acme/api" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(onValueChange).toHaveBeenCalledWith("api");
  });

  it("draws option labels in the mono face when asked", () => {
    const { container, rerender } = render(<RadioList label="Branch" options={options} />);
    expect(container.querySelector(".or-radio-list__options--mono")).toBeNull();
    rerender(<RadioList label="Branch" options={options} mono />);
    expect(container.querySelector(".or-radio-list__options--mono")).not.toBeNull();
  });
});
