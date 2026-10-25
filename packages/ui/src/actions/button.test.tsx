import { IconPlus } from "@tabler/icons-react";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UiProvider, type LinkProps } from "../provider/index.js";
import { Button, type ButtonVariant } from "./button.js";

describe("Button", () => {
  it("renders a native button of type button named by its label, outline and md by default", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.className).toBe("or-btn or-btn--outline or-btn--md");
  });

  it.each<ButtonVariant>(["outline", "solid", "primary", "ghost", "danger"])(
    "draws the %s variant",
    (variant) => {
      render(<Button variant={variant}>Go</Button>);
      expect(screen.getByRole("button", { name: "Go" }).classList).toContain(`or-btn--${variant}`);
    },
  );

  it("draws the sm size", () => {
    render(<Button size="sm">Go</Button>);
    expect(screen.getByRole("button", { name: "Go" }).classList).toContain("or-btn--sm");
  });

  it("renders a leading icon hidden from assistive tech", () => {
    render(<Button icon={IconPlus}>Add repository</Button>);
    const button = screen.getByRole("button", { name: "Add repository" });
    const svg = button.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(button.firstElementChild).toBe(svg);
    expect(button.classList).toContain("or-btn--with-icon");
  });

  it("calls onClick, and not while disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button onClick={onClick} disabled>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("lets a form use type submit", () => {
    render(<Button type="submit">Sign in</Button>);
    expect(screen.getByRole("button", { name: "Sign in" }).getAttribute("type")).toBe("submit");
  });

  it("renders a link through the UiProvider link component when href is given", () => {
    function AppLink(props: LinkProps) {
      return <a data-app-link="" {...props} />;
    }
    render(
      <UiProvider linkComponent={AppLink}>
        <Button href="/repositories" variant="solid">
          Repositories
        </Button>
      </UiProvider>,
    );
    const link = screen.getByRole("link", { name: "Repositories" });
    expect(link.getAttribute("href")).toBe("/repositories");
    expect(link.hasAttribute("data-app-link")).toBe(true);
    expect(link.className).toBe("or-btn or-btn--solid or-btn--md");
  });

  it("renders a plain anchor without a UiProvider", () => {
    render(<Button href="/settings">Settings</Button>);
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings");
  });

  it("renders a disabled link as a disabled button", () => {
    render(
      <Button href="/settings" disabled>
        Settings
      </Button>,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect((screen.getByRole("button", { name: "Settings" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
