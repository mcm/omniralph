// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BlockedBadge, BlockedByLine } from "./blocked";

function TestLink(props: LinkProps) {
  return <a {...props} />;
}

const SRC = path.resolve(__dirname, "../..");

/** Every component (non-test `.tsx`) under `src`: what renders. */
function components(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return components(full);
    return name.endsWith(".tsx") && !name.endsWith(".test.tsx") ? [full] : [];
  });
}

describe("BlockedBadge", () => {
  it("reads Blocked, in the neutral status tone, named Blocked", () => {
    render(<BlockedBadge />);
    const badge = screen.getByRole("img", { name: "Blocked" });
    expect(badge.textContent).toBe("Blocked");
    expect(badge.querySelector(".or-status--neutral")).toBeTruthy();
    expect(badge.querySelector(".or-dot--neutral")).toBeTruthy();
  });
});

describe("BlockedByLine", () => {
  it("renders Blocked by and one IssueBadge per blocker, linking to the Backlog or the tracker", () => {
    render(
      <UiProvider linkComponent={TestLink}>
        <BlockedByLine
          blockers={[
            {
              identifier: "SOC-398",
              url: "https://linear.app/acme/issue/SOC-398",
              backlogId: "linear-issue-398",
            },
            {
              identifier: "SOC-401",
              url: "https://linear.app/acme/issue/SOC-401",
              backlogId: null,
            },
            { identifier: "SOC-402", url: null, backlogId: null },
          ]}
        />
      </UiProvider>,
    );
    const line = screen.getByText("Blocked by").parentElement!;
    expect(line.textContent).toMatch(/^Blocked by/);
    const links = within(line).getAllByRole("link");
    expect(
      links.map((link) => [
        link.querySelector(".or-ref__text")!.textContent,
        link.getAttribute("href"),
      ]),
    ).toEqual([
      ["SOC-398", "/backlog/linear-issue-398"],
      ["SOC-401", "https://linear.app/acme/issue/SOC-401"],
    ]);
    // A blocker with neither: a plain badge.
    expect(line.querySelectorAll(".or-ref--issue")).toHaveLength(3);
  });

  it("renders nothing without blockers", () => {
    const { container } = render(<BlockedByLine blockers={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("the one blocked badge", () => {
  it("is drawn by blocked.tsx alone: no other file renders its own", () => {
    const own = path.join(__dirname, "blocked.tsx");
    const offenders = components().filter((file) => {
      if (file === own) return false;
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      // JSX text or a label that reads "Blocked" (not "Blocked by", nor the component's name).
      return />\s*Blocked\s*</.test(source) || /["'`]Blocked["'`]/.test(source);
    });
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });
});
