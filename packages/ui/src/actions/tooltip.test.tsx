import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Button } from "./button.js";
import { Tooltip } from "./tooltip.js";

describe("Tooltip", () => {
  it("shows on keyboard focus and describes its trigger", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Runs on every agent">
        <Button>Broadcast</Button>
      </Tooltip>,
    );
    await user.tab();
    const trigger = screen.getByRole("button", { name: "Broadcast" });
    expect(document.activeElement).toBe(trigger);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe("Runs on every agent");
    expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id);
  });

  it("shows on hover and hides on Escape", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Runs on every agent" side="bottom">
        <Button>Broadcast</Button>
      </Tooltip>,
    );
    await user.hover(screen.getByRole("button", { name: "Broadcast" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Runs on every agent");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows nothing while disabled", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Runs on every agent" disabled>
        <Button>Broadcast</Button>
      </Tooltip>,
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Broadcast" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
