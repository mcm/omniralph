import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UiProvider, type LinkProps } from "../provider/index.js";
import { TextLink } from "./text-link.js";

describe("TextLink", () => {
  it("renders a plain anchor with the or-link class", () => {
    render(
      <TextLink href="/runs/run-1" className="extra">
        Add the billing export
      </TextLink>,
    );
    const link = screen.getByRole("link", { name: "Add the billing export" });
    expect(link.getAttribute("href")).toBe("/runs/run-1");
    expect(link.className).toBe("or-link extra");
  });

  it("renders through the provider's link component", () => {
    function AppLink(props: LinkProps) {
      return <a data-app-link="" {...props} />;
    }
    render(
      <UiProvider linkComponent={AppLink}>
        <TextLink href="/runs/run-1">Run</TextLink>
      </UiProvider>,
    );
    expect(screen.getByRole("link", { name: "Run" }).hasAttribute("data-app-link")).toBe(true);
  });
});
