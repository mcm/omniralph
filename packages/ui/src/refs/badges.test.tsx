import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { IconCpu } from "@tabler/icons-react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { UiProvider, type LinkProps } from "../provider/index.js";
import {
  AgentBadge,
  BranchBadge,
  ChangeBadge,
  FileBadge,
  fileBadgeLabel,
  IssueBadge,
  MetaBadge,
  OrgBadge,
  RepoBadge,
  SizeBadge,
} from "./badges.js";
import { BrandMark } from "./brand-mark.js";

/**
 * The text assistive tech reads for an element's content: images contribute their
 * `aria-label`, `aria-hidden` subtrees nothing, text nodes their text.
 */
function accessibleText(node: Node): string {
  const parts: string[] = [];
  const walk = (current: Node) => {
    if (current.nodeType === Node.TEXT_NODE) {
      parts.push(current.textContent ?? "");
      return;
    }
    if (!(current instanceof Element)) return;
    if (current.getAttribute("aria-hidden") === "true") return;
    if (current.getAttribute("role") === "img") {
      parts.push(current.getAttribute("aria-label") ?? "");
      return;
    }
    current.childNodes.forEach(walk);
  };
  walk(node);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function badgeOf(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

const LONG = "acme-platform/an-extremely-long-repository-name-that-will-not-fit";

/** Every badge that takes text and `href`, with the accessible text it should read. */
const CASES: { name: string; element: (href?: string) => ReactElement; text: string }[] = [
  {
    name: "OrgBadge",
    element: (href) => <OrgBadge name="Acme" href={href} />,
    text: "Organization Acme",
  },
  {
    name: "RepoBadge (GitHub)",
    element: (href) => <RepoBadge host="github" name="acme/web" href={href} />,
    text: "GitHub acme/web",
  },
  {
    name: "RepoBadge (GitLab)",
    element: (href) => <RepoBadge host="gitlab" name="acme/api" href={href} />,
    text: "GitLab acme/api",
  },
  {
    name: "IssueBadge (Linear)",
    element: (href) => <IssueBadge tracker="linear" id="TOOL-590" href={href} />,
    text: "Linear TOOL-590",
  },
  {
    name: "IssueBadge (Omniralph)",
    element: (href) => <IssueBadge tracker="omniralph" id="OM-12" href={href} />,
    text: "Omniralph OM-12",
  },
  {
    name: "BranchBadge",
    element: (href) => <BranchBadge name="feat/badges" href={href} />,
    text: "Branch feat/badges",
  },
  {
    name: "ChangeBadge (GitLab)",
    element: (href) => <ChangeBadge host="gitlab" number={42} href={href} />,
    text: "Merge request !42",
  },
  {
    name: "ChangeBadge (GitHub)",
    element: (href) => <ChangeBadge host="github" number={7} href={href} />,
    text: "Pull request #7",
  },
  {
    name: "AgentBadge",
    element: (href) => <AgentBadge name="build-box-1" href={href} />,
    text: "Agent build-box-1",
  },
  {
    name: "MetaBadge",
    element: (href) => <MetaBadge icon={IconCpu} text="opus" href={href} />,
    text: "opus",
  },
];

describe("reference badges", () => {
  it.each(CASES)("$name reads its kind and text", ({ element, text }) => {
    const { container } = render(element());
    expect(accessibleText(badgeOf(container))).toBe(text);
  });

  it.each(CASES)("$name is a non-interactive span without href", ({ element }) => {
    const { container } = render(element());
    const badge = badgeOf(container);
    expect(badge.tagName).toBe("SPAN");
    expect(badge.className).toMatch(/^or-ref or-ref--/);
    expect(badge.className).not.toContain("or-ref--link");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(badge.querySelector("[tabindex]")).toBeNull();
  });

  it.each(CASES)(
    "$name renders through the UiProvider link component with href",
    ({ element, text }) => {
      function RouterLink(props: LinkProps) {
        return <a data-router="yes" {...props} />;
      }
      render(<UiProvider linkComponent={RouterLink}>{element("/somewhere")}</UiProvider>);
      const link = screen.getByRole("link", { name: text });
      expect(link.getAttribute("href")).toBe("/somewhere");
      expect(link.getAttribute("data-router")).toBe("yes");
      expect(link.className).toContain("or-ref--link");
    },
  );

  it("truncates long text and keeps the full text in title", () => {
    const { container } = render(<RepoBadge host="github" name={LONG} />);
    const text = badgeOf(container).querySelector(".or-ref__text")!;
    expect(text.textContent).toBe(LONG);
    expect(text.getAttribute("title")).toBe(LONG);
  });

  it.each(CASES)("$name keeps its full text in title", ({ element }) => {
    const { container } = render(element());
    const text = badgeOf(container).querySelector(".or-ref__text")!;
    expect(text.getAttribute("title")).toBe(text.textContent);
  });

  it("titles the organization badge Organization", () => {
    const { container } = render(<OrgBadge name="Acme" />);
    expect(badgeOf(container).getAttribute("title")).toBe("Organization");
    expect(badgeOf(container).querySelector(".tabler-icon-building")).not.toBeNull();
  });

  it("labels the repo badge's mark with its host", () => {
    render(<RepoBadge host="gitlab" name="acme/api" />);
    expect(screen.getByRole("img", { name: "GitLab" })).toBeTruthy();
  });

  it("draws the repo badge strong on request", () => {
    const { container, rerender } = render(<RepoBadge host="github" name="acme/web" />);
    expect(badgeOf(container).className).not.toContain("or-ref--strong");
    rerender(<RepoBadge host="github" name="acme/web" strong />);
    expect(badgeOf(container).className).toContain("or-ref--strong");
  });

  it("uses a 15 px Glyph labeled Omniralph for the Omniralph tracker", () => {
    const { container } = render(<IssueBadge tracker="omniralph" id="OM-12" />);
    const glyph = screen.getByRole("img", { name: "Omniralph" });
    expect(glyph.getAttribute("class")).toContain("or-glyph");
    expect(glyph.getAttribute("width")).toBe("15");
    expect(container.querySelector(".or-ref__text")!.className).toContain("or-mono");
  });

  it("sets IDs, branches and change numbers in mono, names in sans", () => {
    const mono = (element: ReactElement) =>
      badgeOf(render(element).container)
        .querySelector(".or-ref__text")!
        .classList.contains("or-mono");
    expect(mono(<IssueBadge tracker="linear" id="TOOL-1" />)).toBe(true);
    expect(mono(<BranchBadge name="main" />)).toBe(true);
    expect(mono(<ChangeBadge host="github" number={1} />)).toBe(true);
    expect(mono(<OrgBadge name="Acme" />)).toBe(false);
    expect(mono(<RepoBadge host="github" name="a/b" />)).toBe(false);
    expect(mono(<AgentBadge name="box" />)).toBe(false);
    expect(mono(<MetaBadge text="opus" />)).toBe(false);
    expect(mono(<MetaBadge text="12m 4s" mono />)).toBe(true);
  });

  it("uses the branch, merge and server icons", () => {
    const iconOf = (element: ReactElement) =>
      badgeOf(render(element).container).querySelector("svg")!.getAttribute("class");
    expect(iconOf(<BranchBadge name="main" />)).toContain("tabler-icon-git-branch");
    expect(iconOf(<ChangeBadge host="gitlab" number={1} />)).toContain("tabler-icon-git-merge");
    expect(iconOf(<AgentBadge name="box" />)).toContain("tabler-icon-server");
  });

  it("renders MetaBadge without an icon, or with a decorative one", () => {
    const { container, rerender } = render(<MetaBadge text="opus" />);
    expect(badgeOf(container).querySelector("svg")).toBeNull();
    rerender(<MetaBadge text="opus" icon={IconCpu} />);
    const icon = badgeOf(container).querySelector("svg")!;
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(within(badgeOf(container)).queryByRole("img")).toBeNull();
  });

  it("takes a brand mark in place of the icon", () => {
    const { container } = render(
      <MetaBadge
        text="Portal project"
        mark={<BrandMark brand="linear" className="or-ref__icon" />}
      />,
    );
    const badge = badgeOf(container);
    expect(within(badge).getByRole("img", { name: "Linear" })).toBeTruthy();
    expect(badge.textContent).toContain("Portal project");
  });
});

describe("SizeBadge", () => {
  it.each(["XS", "S", "M", "L", "XL"] as const)("shows %s in mono, named Size %s", (size) => {
    render(<SizeBadge size={size} />);
    const badge = screen.getByRole("img", { name: `Size ${size}` });
    expect(badge.textContent).toBe(size);
    expect(badge.className).toBe("or-size or-mono");
  });

  it("shows Size XL as a tooltip on hover", async () => {
    const user = userEvent.setup();
    render(<SizeBadge size="XL" />);
    await user.hover(screen.getByRole("img", { name: "Size XL" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Size XL");
  });

  it("shows Size M as a tooltip on hover", async () => {
    const user = userEvent.setup();
    render(<SizeBadge size="M" />);
    await user.hover(screen.getByRole("img", { name: "Size M" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Size M");
  });
});

describe("FileBadge", () => {
  it("shows the file name in mono after a decorative file icon", () => {
    const { container } = render(<FileBadge path="src/app/page.tsx" startLine={12} endLine={20} />);
    const badge = badgeOf(container);
    expect(badge.tagName).toBe("SPAN");
    expect(badge.className).toMatch(/^or-ref or-ref--file/);
    const text = badge.querySelector(".or-ref__text")!;
    expect(text.textContent).toBe("page.tsx");
    expect(text.className).toContain("or-mono");
    const icon = badge.querySelector("svg")!;
    expect(icon.getAttribute("class")).toContain("tabler-icon-file");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
  });

  it("reads the full path and lines", () => {
    const { container, rerender } = render(
      <FileBadge path="src/app/page.tsx" startLine={12} endLine={20} />,
    );
    expect(accessibleText(badgeOf(container))).toBe("src/app/page.tsx · lines 12–20");
    rerender(<FileBadge path="src/app/page.tsx" startLine={7} endLine={7} />);
    expect(accessibleText(badgeOf(container))).toBe("src/app/page.tsx · line 7");
    rerender(<FileBadge path="README.md" />);
    expect(accessibleText(badgeOf(container))).toBe("README.md");
  });

  it("labels paths and lines", () => {
    expect(fileBadgeLabel("a/b.ts", 3, 9)).toBe("a/b.ts · lines 3–9");
    expect(fileBadgeLabel("a/b.ts", 3, null)).toBe("a/b.ts · line 3");
    expect(fileBadgeLabel("a/b.ts", null, null)).toBe("a/b.ts");
  });

  it("shows the path and lines as a tooltip on hover", async () => {
    const user = userEvent.setup();
    const { container } = render(<FileBadge path="lib/x/y.ts" startLine={1} endLine={4} />);
    await user.hover(badgeOf(container));
    expect((await screen.findByRole("tooltip")).textContent).toBe("lib/x/y.ts · lines 1–4");
  });

  it("links through the UiProvider link component with href, named by its path", async () => {
    function RouterLink(props: LinkProps) {
      return <a data-router="yes" {...props} />;
    }
    const href = "https://github.com/acme/web/blob/main/src/app/page.tsx#L12-L20";
    render(
      <UiProvider linkComponent={RouterLink}>
        <FileBadge path="src/app/page.tsx" startLine={12} endLine={20} href={href} />
      </UiProvider>,
    );
    const link = screen.getByRole("link", { name: "src/app/page.tsx · lines 12–20" });
    expect(link.getAttribute("href")).toBe(href);
    expect(link.getAttribute("data-router")).toBe("yes");
    expect(link.className).toContain("or-ref--link");
    const user = userEvent.setup();
    await user.hover(link);
    expect((await screen.findByRole("tooltip")).textContent).toBe("src/app/page.tsx · lines 12–20");
  });
});
