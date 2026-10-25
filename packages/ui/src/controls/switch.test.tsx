import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "./switch.js";

describe("Switch", () => {
  it("renders a button with role switch and aria-checked", () => {
    render(<Switch aria-label="Auto-merge" checked={false} />);
    const control = screen.getByRole("switch", { name: "Auto-merge" });
    expect(control.tagName).toBe("BUTTON");
    expect(control).toHaveProperty("type", "button");
    expect(control.getAttribute("aria-checked")).toBe("false");
  });

  it("is named by its visible label, and clicking the label toggles it", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch label="Require review" onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole("switch", { name: "Require review" });
    await user.click(screen.getByText("Require review"));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(control.getAttribute("aria-checked")).toBe("true");
  });

  it("can be named by aria-labelledby", () => {
    render(
      <>
        <span id="heading">Notifications</span>
        <Switch aria-labelledby="heading" />
      </>,
    );
    expect(screen.getByRole("switch", { name: "Notifications" })).toBeTruthy();
  });

  it("toggles on click", async () => {
    const user = userEvent.setup();
    render(<Switch aria-label="Auto-merge" />);
    const control = screen.getByRole("switch");
    await user.click(control);
    expect(control.getAttribute("aria-checked")).toBe("true");
    await user.click(control);
    expect(control.getAttribute("aria-checked")).toBe("false");
  });

  it("toggles on Space and on Enter", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Auto-merge" onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole("switch");
    await user.tab();
    expect(document.activeElement).toBe(control);
    await user.keyboard(" ");
    expect(control.getAttribute("aria-checked")).toBe("true");
    await user.keyboard("{Enter}");
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(onCheckedChange.mock.calls).toEqual([[true], [false]]);
  });

  it("follows the checked prop when controlled", async () => {
    const user = userEvent.setup();
    function Controlled() {
      const [on, setOn] = useState(true);
      return <Switch aria-label="Auto-merge" checked={on} onCheckedChange={setOn} />;
    }
    render(<Controlled />);
    const control = screen.getByRole("switch");
    expect(control.getAttribute("aria-checked")).toBe("true");
    await user.click(control);
    expect(control.getAttribute("aria-checked")).toBe("false");
  });

  it("does not toggle when disabled", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch label="Auto-merge" disabled onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole("switch", { name: "Auto-merge" });
    expect(control).toHaveProperty("disabled", true);
    await user.click(control);
    await user.click(screen.getByText("Auto-merge"));
    control.focus();
    await user.keyboard(" {Enter}");
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(control.getAttribute("aria-checked")).toBe("false");
  });

  it("requires a name at the type level", () => {
    // @ts-expect-error: a switch needs a label, aria-label or aria-labelledby
    expect(() => render(<Switch />)).not.toThrow();
  });
});
