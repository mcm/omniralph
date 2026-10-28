import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DetailsPopover, InfoPopover } from "./popovers.js";

function renderDetails() {
  return render(
    <DetailsPopover
      label="Run details"
      items={[
        { term: "Run", detail: "run_42" },
        { term: "Branch", detail: "om/tool-602" },
      ]}
    />,
  );
}

describe("InfoPopover", () => {
  it("takes a custom label", () => {
    render(<InfoPopover label="About usage">From transcripts.</InfoPopover>);
    expect(screen.getByRole("button", { name: "About usage" })).toBeTruthy();
  });
});

describe("DetailsPopover", () => {
  it("defaults its label to Details and uses the ID-card icon", () => {
    const { container } = render(<DetailsPopover items={[]} />);
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
    expect(container.querySelector("svg.tabler-icon-id")).toBeTruthy();
  });

  it("opens on click with a definition list and closes on Escape, returning focus", async () => {
    const user = userEvent.setup();
    renderDetails();
    const button = screen.getByRole("button", { name: "Run details" });
    await user.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Run details" });
    const list = dialog.querySelector("dl");
    expect(list).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole("term")
        .map((term) => term.textContent),
    ).toEqual(["Run", "Branch"]);
    expect(
      within(dialog)
        .getAllByRole("definition")
        .map((detail) => detail.textContent),
    ).toEqual(["run_42", "om/tool-602"]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
