import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UiProvider, type LinkProps } from "../provider/index.js";
import { BrandLockup, Wordmark } from "./wordmark.js";

describe("Wordmark", () => {
  it("renders lowercase omniralph", () => {
    render(<Wordmark />);
    expect(screen.getByText("omniralph").className).toBe("or-wordmark");
  });
});

describe("BrandLockup", () => {
  it("renders the 24 px glyph and the wordmark, without a link by default", () => {
    const { container } = render(<BrandLockup />);
    const lockup = container.firstElementChild!;
    expect(lockup.className).toBe("or-lockup");
    expect(lockup.querySelector("svg")!.getAttribute("width")).toBe("24");
    expect(lockup.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(lockup.querySelector(".or-wordmark")!.textContent).toBe("omniralph");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("is a home link named Omniralph home when given href", () => {
    render(<BrandLockup href="/" />);
    const link = screen.getByRole("link", { name: "Omniralph home" });
    expect(link.getAttribute("href")).toBe("/");
    expect(link.querySelector("svg")).not.toBeNull();
  });

  it("renders the link through the UiProvider link component", () => {
    function RouterLink(props: LinkProps) {
      return <a data-router="" {...props} />;
    }
    render(
      <UiProvider linkComponent={RouterLink}>
        <BrandLockup href="/inbox" />
      </UiProvider>,
    );
    const link = screen.getByRole("link", { name: "Omniralph home" });
    expect(link.hasAttribute("data-router")).toBe(true);
    expect(link.getAttribute("href")).toBe("/inbox");
  });
});
