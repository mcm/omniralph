import { IconRefresh } from "@tabler/icons-react";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IconButton } from "./icon-button.js";

describe("IconButton", () => {
  it("is a button named by its label", () => {
    render(<IconButton label="Retry" icon={IconRefresh} onClick={() => {}} />);
    const button = screen.getByRole("button", { name: "Retry" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Retry");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(button.className).toBe("or-icon-btn or-icon-btn--ghost or-icon-btn--md");
  });

  it("draws the outline variant and sm size", () => {
    render(<IconButton label="Retry" icon={IconRefresh} variant="outline" size="sm" />);
    expect(screen.getByRole("button", { name: "Retry" }).className).toBe(
      "or-icon-btn or-icon-btn--outline or-icon-btn--sm",
    );
  });

  it("shows its label as a tooltip on keyboard focus", async () => {
    const user = userEvent.setup();
    render(<IconButton label="Retry" icon={IconRefresh} />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Retry");
  });

  it("shows its label as a tooltip on hover", async () => {
    const user = userEvent.setup();
    render(<IconButton label="Retry" icon={IconRefresh} />);
    await user.hover(screen.getByRole("button", { name: "Retry" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Retry");
  });

  it("does nothing while disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<IconButton label="Retry" icon={IconRefresh} onClick={onClick} disabled />);
    const button = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("shows why it is disabled and stays focusable with disabledReason", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <IconButton
        label="Pin agent"
        icon={IconRefresh}
        onClick={onClick}
        disabled
        disabledReason="Every agent is already pinned"
      />,
    );
    const button = screen.getByRole("button", { name: "Pin agent" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await user.tab();
    expect(document.activeElement).toBe(button);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Every agent is already pinned");
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("shows its tooltip in place of the label, still named by the label", async () => {
    const user = userEvent.setup();
    render(
      <IconButton
        label="Start epic SOC-412"
        icon={IconRefresh}
        tooltip="Starts when SOC-398 is done"
      />,
    );
    const button = screen.getByRole("button", { name: "Start epic SOC-412" });
    await user.hover(button);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Starts when SOC-398 is done");
  });

  it("renders a link named by its label when href is given", () => {
    render(
      <IconButton label="Open pull request" icon={IconRefresh} href="https://example.com/pr/1" />,
    );
    const link = screen.getByRole("link", { name: "Open pull request" });
    expect(link.getAttribute("href")).toBe("https://example.com/pr/1");
  });

  it("requires a label (typecheck)", () => {
    // @ts-expect-error -- label is required: it is the accessible name and the tooltip
    const element = <IconButton icon={IconRefresh} />;
    expect(element).toBeTruthy();
  });
});
