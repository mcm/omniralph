import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "../actions/button.js";
import { IconButton } from "../actions/icon-button.js";
import { IssueBadge } from "../refs/badges.js";
import { externalLinkProps, isExternalHref } from "./external-link.js";
import { UiProvider, type LinkProps } from "./ui-provider.js";
import { IconExternalLink } from "@tabler/icons-react";

afterEach(cleanup);

const ORIGIN = "https://panel.example.com";

describe("isExternalHref", () => {
  it.each([
    "https://linear.app/acme/issue/SOC-1",
    "http://gitlab.example.com/group/repo",
    "//github.com/acme/repo",
    "HTTPS://GITHUB.COM/acme",
  ])("treats %s as external", (href) => {
    expect(isExternalHref(href, ORIGIN)).toBe(true);
  });

  it.each([
    "/runs/42",
    "runs?tab=log",
    "#agents",
    "?tab=coding",
    "mailto:ops@example.com",
    "https://panel.example.com/repos/1",
    "javascript:alert(1)",
  ])("keeps %s internal", (href) => {
    expect(isExternalHref(href, ORIGIN)).toBe(false);
  });

  it("counts every absolute URL as external when the origin is unknown", () => {
    expect(isExternalHref("https://panel.example.com/repos", undefined)).toBe(true);
    expect(isExternalHref("/repos", undefined)).toBe(false);
  });
});

describe("externalLinkProps", () => {
  it("leaves internal links alone", () => {
    const props = { href: "/backlog", children: "Backlog" };
    expect(externalLinkProps(props, ORIGIN)).toBe(props);
  });

  it("lets an explicit target keep an external link in this tab", () => {
    const props = { href: "https://linear.app", target: "_self" };
    expect(externalLinkProps(props, ORIGIN)).toBe(props);
  });

  it("keeps the caller's rel tokens alongside noopener noreferrer", () => {
    const result = externalLinkProps<LinkProps>(
      { href: "https://github.com", rel: "nofollow" },
      ORIGIN,
    );
    expect(result.target).toBe("_blank");
    expect(result.rel?.split(" ").sort()).toEqual(["nofollow", "noopener", "noreferrer"]);
  });

  it("hints only once when applied twice", () => {
    const once = externalLinkProps({ href: "https://github.com", children: "GitHub" }, ORIGIN);
    render(<a {...externalLinkProps(once, ORIGIN)} />);
    expect(screen.getByRole("link").textContent).toBe("GitHub (opens in a new tab)");
  });
});

describe("links drawn by the components", () => {
  function RouterLink(props: LinkProps) {
    return <a {...props} data-router="yes" />;
  }

  it("open external pages in a new tab and say so", () => {
    render(
      <UiProvider linkComponent={RouterLink}>
        <Button href="https://linear.app/acme/issue/SOC-1">Open in Linear</Button>
        <Button href="/runs">Runs</Button>
      </UiProvider>,
    );
    const external = screen.getByRole("link", { name: "Open in Linear (opens in a new tab)" });
    expect(external.getAttribute("target")).toBe("_blank");
    expect(external.getAttribute("rel")).toBe("noopener noreferrer");
    expect(external.dataset.router).toBe("yes");
    const internal = screen.getByRole("link", { name: "Runs" });
    expect(internal.getAttribute("target")).toBeNull();
  });

  it("puts the hint in the label of an icon-only link", () => {
    render(<IconButton label="Open" icon={IconExternalLink} href="https://github.com/acme" />);
    expect(screen.getByRole("link", { name: "Open (opens in a new tab)" })).toBeTruthy();
  });

  it("opens a badge's tracker link in a new tab without a provider", () => {
    render(<IssueBadge tracker="linear" id="SOC-1" href="https://linear.app/acme/issue/SOC-1" />);
    expect(screen.getByRole("link").getAttribute("target")).toBe("_blank");
  });
});
