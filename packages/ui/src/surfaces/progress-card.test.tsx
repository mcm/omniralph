import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkProps } from "../provider/index.js";
import { UiProvider } from "../provider/index.js";
import { ProgressCard } from "./progress-card.js";
import type { ProgressStep } from "./progress.js";

const STEPS: ProgressStep[] = [
  { id: "a", label: "Write the PRD", state: "done", meta: "4m" },
  { id: "b", label: "Approve the PRD", state: "waiting", href: "/prd/1" },
  { id: "c", label: "Build the stories", state: "blocked" },
  { id: "d", label: "Review", state: "done" },
];

describe("ProgressCard", () => {
  it("renders a section named by its title with the bar, count and ordered steps", () => {
    render(<ProgressCard title="Plan" steps={STEPS} />);
    const card = screen.getByRole("region", { name: "Plan" });
    const bar = within(card).getByRole("progressbar", { name: "Plan" });
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("4");
    expect(bar.getAttribute("aria-valuetext")).toBe("2 of 4 done · 1 waiting on you · 1 blocked");
    expect(within(card).getByText("2 of 4 done · 1 waiting on you · 1 blocked")).toBeTruthy();

    const list = within(card).getByRole("list");
    expect(list.tagName).toBe("OL");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Write the PRD4m",
      "Approve the PRD",
      "Build the stories",
      "Review",
    ]);
    expect(within(items[1]!).getByRole("img", { name: "Waiting on you" })).toBeTruthy();
    expect(within(items[0]!).getByRole("img", { name: "Done" })).toBeTruthy();
    expect(
      within(items[1]!).getByRole("link", { name: "Approve the PRD" }).getAttribute("href"),
    ).toBe("/prd/1");
  });

  it("draws one segment per step in its state, each an equal share", () => {
    const { container } = render(<ProgressCard title="Plan" steps={STEPS} />);
    const segments = Array.from(container.querySelectorAll<HTMLElement>(".or-progress__seg"));
    expect(segments.map((segment) => segment.className)).toEqual([
      "or-progress__seg or-progress__seg--done",
      "or-progress__seg or-progress__seg--waiting",
      "or-progress__seg or-progress__seg--blocked",
      "or-progress__seg or-progress__seg--done",
    ]);
    expect(segments.every((segment) => segment.style.width === "25%")).toBe(true);
  });

  it("links the title through the UiProvider link component", () => {
    function TestLink(props: LinkProps) {
      return <a {...props} data-router="yes" />;
    }
    render(
      <UiProvider linkComponent={TestLink}>
        <ProgressCard title="Plan" titleHref="/runs/7" steps={STEPS} />
      </UiProvider>,
    );
    const link = screen.getByRole("link", { name: "Plan" });
    expect(link.getAttribute("href")).toBe("/runs/7");
    expect(link.dataset.router).toBe("yes");
    expect(screen.getByRole("region", { name: "Plan" })).toBeTruthy();
  });

  it("shows an empty bar and no list with zero steps", () => {
    render(<ProgressCard title="Plan" steps={[]} />);
    const bar = screen.getByRole("progressbar", { name: "Plan" });
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("0");
    expect(bar.getAttribute("aria-valuetext")).toBe("No steps yet");
    expect(screen.getByText("No steps yet")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });
});
