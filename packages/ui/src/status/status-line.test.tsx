import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { STATUS_TONES } from "./status.js";
import { STATUS_LINE_DOT_LABELS, StatusLine } from "./status-line.js";

describe("StatusLine", () => {
  it.each(STATUS_TONES)("is a status named by its sentence, in the %s tone", (tone) => {
    render(<StatusLine tone={tone}>Waiting on you for 15 days</StatusLine>);
    const line = screen.getByRole("status", { name: "Waiting on you for 15 days" });
    expect(line.className).toBe(`or-statusline or-statusline--${tone}`);
    expect(line.textContent).toBe("Waiting on you for 15 days");
    const dot = within(line).getByRole("img", { name: STATUS_LINE_DOT_LABELS[tone] });
    expect(dot.className).toBe(`or-dot or-dot--${tone}`);
    expect(line.firstElementChild).toBe(dot);
  });

  it("names the dot with dotLabel when given", () => {
    render(
      <StatusLine tone="run" dotLabel="Epic running">
        Running for 2 hours
      </StatusLine>,
    );
    const line = screen.getByRole("status", { name: "Running for 2 hours" });
    expect(within(line).getByRole("img", { name: "Epic running" })).toBeTruthy();
  });

  it("takes rich children and an extra class", () => {
    render(
      <StatusLine tone="fail" className="x">
        Failed <time dateTime="2026-10-25">yesterday</time>
      </StatusLine>,
    );
    const line = screen.getByRole("status", { name: "Failed yesterday" });
    expect(line.classList.contains("x")).toBe(true);
  });
});
