// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunProgress } from "./run-progress";
import { epicRunDetail, reviewRunDetail } from "./test-fixtures";

function TestLink(props: LinkProps) {
  return <a {...props} data-router="yes" />;
}

const renderWithLinks = (ui: React.ReactNode) =>
  render(<UiProvider linkComponent={TestLink}>{ui}</UiProvider>);

const stepTexts = (card: HTMLElement) =>
  within(card)
    .getAllByRole("listitem")
    .map((item) => item.textContent);

describe("RunProgress in link mode", () => {
  it("titles an epic Epic progress and links to the run", () => {
    renderWithLinks(<RunProgress run={epicRunDetail()} mode="link" />);
    const card = screen.getByRole("region", { name: "Epic progress" });
    const link = within(card).getByRole("link", { name: "Open run" });
    expect(link.getAttribute("href")).toBe("/runs/run-1");
    expect(link.dataset.router).toBe("yes");
    expect(within(card).getByText("1 of 3 done · 1 running · 18m")).toBeTruthy();
    expect(stepTexts(card)).toEqual(["Story 113m", "Story 25m", "Story 3"]);
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("titles a review Review passes, its passes and the correlation as steps", () => {
    renderWithLinks(<RunProgress run={reviewRunDetail()} mode="link" />);
    const card = screen.getByRole("region", { name: "Review passes" });
    expect(within(card).getByRole("link", { name: "Open run" }).getAttribute("href")).toBe(
      "/runs/run-3",
    );
    expect(within(card).getByText("1 of 3 done · 2 running · 45s")).toBeTruthy();
    expect(stepTexts(card)).toEqual(["Security45s", "Correctness", "Merge the passes' findings"]);
  });
});

describe("RunProgress in select mode", () => {
  it("titles an epic Stories and makes its stories selectable", async () => {
    const user = userEvent.setup();
    const onSelectStep = vi.fn();
    renderWithLinks(
      <RunProgress
        run={epicRunDetail()}
        mode="select"
        selectedStepId="2"
        onSelectStep={onSelectStep}
      />,
    );
    const card = screen.getByRole("region", { name: "Stories" });
    expect(within(card).queryByRole("link")).toBeNull();
    expect(within(card).getByRole("button", { current: "step" }).textContent).toBe("Story 25m");
    await user.click(within(card).getByRole("button", { name: /Story 3/ }));
    expect(onSelectStep).toHaveBeenCalledWith("3");
  });

  it("titles a review Review passes and makes its passes selectable", async () => {
    const user = userEvent.setup();
    const onSelectStep = vi.fn();
    renderWithLinks(
      <RunProgress
        run={reviewRunDetail()}
        mode="select"
        selectedStepId={undefined}
        onSelectStep={onSelectStep}
      />,
    );
    const card = screen.getByRole("region", { name: "Review passes" });
    expect(within(card).getAllByRole("button")).toHaveLength(3);
    expect(within(card).queryByRole("button", { current: "step" })).toBeNull();
    await user.click(within(card).getByRole("button", { name: /Correctness/ }));
    expect(onSelectStep).toHaveBeenCalledWith("pass-2");
  });

  it("titles the turns of a request, triage or ask Turns", () => {
    const { rerender } = renderWithLinks(
      <RunProgress run={{ ...epicRunDetail(), kind: "request" }} mode="link" />,
    );
    expect(screen.getByRole("region", { name: "Turns" })).toBeTruthy();
    rerender(
      <UiProvider linkComponent={TestLink}>
        <RunProgress
          run={{ ...epicRunDetail(), kind: "triage" }}
          mode="select"
          selectedStepId={undefined}
          onSelectStep={() => {}}
        />
      </UiProvider>,
    );
    expect(screen.getByRole("region", { name: "Turns" })).toBeTruthy();
  });
});
