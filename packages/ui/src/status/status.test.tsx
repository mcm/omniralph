import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { STATUS_TONES, StatusDot, StatusText, type StatusTone } from "./status.js";

const LABELS: Record<StatusTone, string> = {
  need: "Needs you",
  run: "Running",
  good: "Merged",
  warn: "Stopped",
  fail: "Failed",
  neutral: "Queued",
};

describe("StatusDot", () => {
  it.each(STATUS_TONES)("draws the %s tone as an image named by its label", (tone) => {
    render(<StatusDot tone={tone} label={LABELS[tone]} />);
    const dot = screen.getByRole("img", { name: LABELS[tone] });
    expect(dot.className).toBe(`or-dot or-dot--${tone}`);
    expect(dot.textContent).toBe("");
  });

  it("requires a label", () => {
    // @ts-expect-error label is required
    render(<StatusDot tone="run" />);
  });
});

describe("StatusText", () => {
  it.each(STATUS_TONES)("renders the %s label next to a decorative dot", (tone) => {
    const { container } = render(<StatusText tone={tone}>{LABELS[tone]}</StatusText>);
    const status = container.firstElementChild!;
    expect(status.className).toBe(`or-status or-status--${tone}`);
    expect(status.textContent).toBe(LABELS[tone]);
    const dot = status.firstElementChild!;
    expect(dot.className).toBe(`or-dot or-dot--${tone}`);
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(LABELS[tone])).toBe(status);
  });
});
