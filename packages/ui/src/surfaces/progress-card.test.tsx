import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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

  it("draws a canceled step with a dash icon and a border-colored segment", () => {
    const { container } = render(
      <ProgressCard
        title="Stories"
        steps={[
          { id: "a", label: "One", state: "done" },
          { id: "b", label: "Two", state: "canceled" },
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    const icon = within(items[1]!).getByRole("img", { name: "Canceled" });
    expect(icon.className).toBe("or-step__icon or-step__icon--canceled");
    expect(icon.querySelector("svg")).not.toBeNull();
    expect(items[1]!.className).toBe("or-step or-step--canceled");
    expect(container.querySelectorAll(".or-progress__seg--canceled")).toHaveLength(1);
    expect(screen.getByText("1 of 2 done · 1 canceled")).toBeTruthy();
  });

  it("tells done, pending, blocked and failed steps apart by shape, not only by color", () => {
    render(
      <ProgressCard
        title="Stories"
        steps={[
          { id: "a", label: "One", state: "done" },
          { id: "b", label: "Two", state: "pending" },
          { id: "c", label: "Three", state: "blocked" },
          { id: "d", label: "Four", state: "failed" },
          { id: "e", label: "Five", state: "canceled" },
        ]}
      />,
    );
    const names = ["Done", "Pending", "Blocked", "Failed", "Canceled"];
    const icons = screen
      .getAllByRole("listitem")
      .map((item, index) => within(item).getByRole("img", { name: names[index] }));
    // No neutral dot that differs from the others by color only.
    for (const icon of icons) expect(icon.classList).not.toContain("or-dot");
    const shapes = icons.map((icon) => `${icon.className}|${icon.innerHTML}`);
    expect(new Set(icons.map((icon) => icon.innerHTML)).size).toBe(icons.length);
    expect(shapes[1]).toContain("or-step__icon--pending");
    expect(icons[1]!.querySelector("svg")).toBeNull();
    for (const index of [0, 2, 3, 4]) expect(icons[index]!.querySelector("svg")).not.toBeNull();
  });

  it("keeps the status dot for running and waiting steps", () => {
    render(
      <ProgressCard
        title="Stories"
        steps={[
          { id: "a", label: "One", state: "running" },
          { id: "b", label: "Two", state: "waiting" },
        ]}
      />,
    );
    expect(screen.getByRole("img", { name: "Running" }).className).toBe("or-dot or-dot--run");
    expect(screen.getByRole("img", { name: "Waiting on you" }).className).toBe(
      "or-dot or-dot--need",
    );
  });

  it("appends the summary suffix to the count line and the bar's value text", () => {
    render(<ProgressCard title="Plan" steps={STEPS} summarySuffix="3h 31m" />);
    const text = "2 of 4 done · 1 waiting on you · 1 blocked · 3h 31m";
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe(text);
  });

  it("renders the header actions", () => {
    render(<ProgressCard title="Plan" steps={STEPS} actions={<a href="/runs/1">Open run</a>} />);
    const card = screen.getByRole("region", { name: "Plan" });
    expect(within(card).getByRole("link", { name: "Open run" })).toBeTruthy();
  });

  it("renders no buttons without onSelectStep", () => {
    render(<ProgressCard title="Plan" steps={STEPS} selectedStepId="a" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector("[aria-current]")).toBeNull();
  });

  it("makes the steps buttons when selectable, marking the selected one", async () => {
    const user = userEvent.setup();
    const onSelectStep = vi.fn();
    render(
      <ProgressCard title="Plan" steps={STEPS} selectedStepId="c" onSelectStep={onSelectStep} />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Write the PRD4m",
      "Approve the PRD",
      "Build the stories",
      "Review",
    ]);
    // A selectable step is a button, never a link.
    expect(screen.queryByRole("link")).toBeNull();
    const selected = screen.getByRole("button", { current: "step" });
    expect(selected.textContent).toBe("Build the stories");
    expect(selected.closest("li")!.className).toBe("or-step or-step--blocked or-step--selected");
    expect(buttons.filter((button) => button.hasAttribute("aria-current"))).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /Approve the PRD/ }));
    expect(onSelectStep).toHaveBeenCalledWith("b");
  });

  it("shows the step panel inside the selected step, under it", () => {
    render(
      <ProgressCard
        title="Plan"
        steps={STEPS}
        selectedStepId="c"
        onSelectStep={vi.fn()}
        stepPanel={<p>Transcript of the stories</p>}
      />,
    );
    const panel = screen.getByText("Transcript of the stories").parentElement!;
    expect(panel.className).toBe("or-step__panel");
    const step = panel.closest("li")!;
    expect(step.className).toContain("or-step--selected");
    expect(panel.previousElementSibling).toBe(screen.getByRole("button", { current: "step" }));
  });

  it("shows no step panel without step selection", () => {
    render(<ProgressCard title="Plan" steps={STEPS} stepPanel={<p>Panel</p>} />);
    expect(screen.queryByText("Panel")).toBeNull();
  });

  it("gives each selectable step a chevron link to its own view, beside its button", () => {
    render(
      <ProgressCard
        title="Plan"
        steps={STEPS}
        selectedStepId="c"
        onSelectStep={vi.fn()}
        stepHref={(id) => `/runs/1/steps/${id}`}
        stepPanel={<p>Panel</p>}
      />,
    );
    const card = screen.getByRole("region", { name: "Plan" });
    expect(card.className).toContain("or-progress-card--step-links");
    const link = screen.getByRole("link", { name: "Open Approve the PRD" });
    expect(link.getAttribute("href")).toBe("/runs/1/steps/b");
    expect(link.className).toBe("or-step__open");
    // A sibling of the step's button, never inside it.
    expect(link.closest("button")).toBeNull();
    expect(link.querySelector("a, button")).toBeNull();
    expect(link.previousElementSibling?.tagName).toBe("BUTTON");
    expect(screen.getAllByRole("link")).toHaveLength(STEPS.length);
    expect(screen.getByText("Panel")).toBeTruthy();
  });

  it("draws no chevron links without step selection", () => {
    render(<ProgressCard title="Plan" steps={STEPS} stepHref={(id) => `/s/${id}`} />);
    expect(screen.queryByRole("link", { name: /^Open / })).toBeNull();
    expect(screen.getByRole("region", { name: "Plan" }).className).not.toContain("step-links");
  });
});
