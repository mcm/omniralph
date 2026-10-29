import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ListLoading } from "./list-loading.js";

describe("ListLoading", () => {
  it("is a busy status named by its label, with placeholder rows hidden from assistive technology", () => {
    const { container } = render(<ListLoading label="Loading the Inbox" rows={3} />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.textContent).toBe("Loading the Inbox");
    // No aria-label on an element without a role that allows it (axe aria-prohibited-attr).
    expect(container.querySelector("[aria-label]")).toBeNull();
    const rows = container.querySelectorAll(".or-list-loading__row");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("draws five rows by default and at least one", () => {
    const { container, rerender } = render(<ListLoading label="Loading repos" />);
    expect(container.querySelectorAll(".or-list-loading__row")).toHaveLength(5);
    rerender(<ListLoading label="Loading repos" rows={0} />);
    expect(container.querySelectorAll(".or-list-loading__row")).toHaveLength(1);
  });
});
