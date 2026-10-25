import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UiProvider, useLinkComponent, type LinkProps } from "./ui-provider.js";

function NavLink({ href, label }: { href: string; label: string }) {
  const Link = useLinkComponent();
  return <Link href={href}>{label}</Link>;
}

function RouterLink(props: LinkProps) {
  return <a {...props} data-router="yes" />;
}

afterEach(cleanup);

describe("UiProvider", () => {
  it("renders links with the provided link component", () => {
    render(
      <UiProvider linkComponent={RouterLink}>
        <NavLink href="/runs" label="Runs" />
      </UiProvider>,
    );
    const link = screen.getByRole("link", { name: "Runs" });
    expect(link.getAttribute("href")).toBe("/runs");
    expect(link.dataset.router).toBe("yes");
  });

  it("defaults to a plain anchor", () => {
    render(
      <UiProvider>
        <NavLink href="/repos" label="Repos" />
      </UiProvider>,
    );
    const link = screen.getByRole("link", { name: "Repos" });
    expect(link.getAttribute("href")).toBe("/repos");
    expect(link.dataset.router).toBeUndefined();
  });

  it("uses a plain anchor without a provider", () => {
    render(<NavLink href="/fleet" label="Fleet" />);
    expect(screen.getByRole("link", { name: "Fleet" }).getAttribute("href")).toBe("/fleet");
  });
});
