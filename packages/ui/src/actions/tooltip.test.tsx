import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Button } from "./button.js";
import { Tooltip } from "./tooltip.js";

describe("Tooltip", () => {
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
