import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { StatusIndicator } from "./status-indicator.js";

describe("StatusIndicator", () => {
  it("shows the label after a decorative dot by default", () => {
    const { container } = render(<StatusIndicator tone="good" label="Idle" />);
    const status = container.firstElementChild!;
    expect(status.className).toBe("or-status or-status--good");
    expect(status.textContent).toBe("Idle");
    expect(status.querySelector(".or-dot--good")?.getAttribute("aria-hidden")).toBe("true");
    expect(status.hasAttribute("aria-description")).toBe(false);
  });

  it("draws the dot alone, named by the label", () => {
    render(<StatusIndicator variant="dot" tone="fail" label="No agent online" className="x" />);
    const dot = screen.getByRole("img", { name: "No agent online" });
    expect(dot.className).toBe("or-dot or-dot--fail x");
  });

  it("shows its tooltip on hover and keeps it as the status's description", async () => {
    const user = userEvent.setup();
    render(<StatusIndicator tone="run" label="Running 2" tooltip="Last seen just now" />);
    const status = screen.getByText("Running 2");
    expect(status.getAttribute("aria-description")).toBe("Last seen just now");
    await user.hover(status);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Last seen just now");
  });

  it("marks only a trigger with a tooltip to stay above a linked row's link", () => {
    render(
      <>
        <StatusIndicator tone="good" label="Idle" tooltip="Last seen just now" className="x" />
        <StatusIndicator variant="dot" tone="run" label="Busy" tooltip="Running 1" />
        <StatusIndicator tone="fail" label="Offline" />
      </>,
    );
    expect(screen.getByText("Idle").className).toBe(
      "or-status or-status--good or-status-indicator x",
    );
    expect(screen.getByRole("img", { name: "Busy" }).className).toBe(
      "or-dot or-dot--run or-status-indicator",
    );
    expect(screen.getByText("Offline").className).toBe("or-status or-status--fail");
  });

  it("doesn't describe a dot by a tooltip that repeats its name", () => {
    render(<StatusIndicator variant="dot" tone="run" label="2 running" tooltip="2 running" />);
    expect(screen.getByRole("img", { name: "2 running" }).hasAttribute("aria-description")).toBe(
      false,
    );
  });

  it("adds no tab stop inside a link", async () => {
    const user = userEvent.setup();
    render(
      <>
        <a href="/repos/portal">
          portal{" "}
          <StatusIndicator variant="dot" tone="fail" label="Down" tooltip="Down and 1 more" />
        </a>
        <button type="button">after</button>
      </>,
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link"));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "after" }));
  });
});
