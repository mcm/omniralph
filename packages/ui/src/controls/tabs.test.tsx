import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TabPanel, Tabs, tabAccessibleName, type TabItem } from "./tabs.js";

const tabs: TabItem[] = [
  { value: "need", label: "Needs you", count: 4, countTone: "need" },
  { value: "running", label: "Running", count: 2 },
  { value: "failed", label: "Failed", count: 1, countTone: "fail" },
  { value: "done", label: "Done" },
];

function setup(onValueChange = vi.fn()) {
  const user = userEvent.setup();
  render(
    <Tabs aria-label="Run views" tabs={tabs} onValueChange={onValueChange}>
      {tabs.map((tab) => (
        <TabPanel key={tab.value} value={tab.value}>
          {tab.label} panel
        </TabPanel>
      ))}
    </Tabs>,
  );
  return { user, onValueChange };
}

const tab = (name: string) => screen.getByRole("tab", { name });
const selected = () =>
  screen.getAllByRole("tab").filter((el) => el.getAttribute("aria-selected") === "true");

describe("Tabs", () => {
  it("renders a named tablist of tabs, the first selected", () => {
    setup();
    expect(screen.getByRole("tablist", { name: "Run views" })).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(selected()).toEqual([tab("Needs you, 4")]);
    expect(tab("Running, 2").getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tabpanel", { name: "Needs you, 4" }).textContent).toBe(
      "Needs you panel",
    );
  });

  it("includes each count in the tab's accessible name", () => {
    setup();
    expect(
      screen.getAllByRole("tab").map((el) => el.getAttribute("aria-label") ?? el.textContent),
    ).toEqual(["Needs you, 4", "Running, 2", "Failed, 1", "Done"]);
    expect(tabAccessibleName({ label: "Queued", count: 0 })).toBe("Queued, 0");
  });

  it("tones the counts", () => {
    setup();
    const count = (name: string) => tab(name).querySelector(".or-tab__count")!.className;
    expect(count("Needs you, 4")).toContain("or-tab__count--need");
    expect(count("Failed, 1")).toContain("or-tab__count--fail");
    expect(count("Running, 2")).toBe("or-tab__count");
  });

  it("keeps a count of 0 neutral whatever its tone", () => {
    render(
      <Tabs
        aria-label="Inbox"
        value="need"
        onValueChange={() => {}}
        tabs={[
          { value: "need", label: "Needs you", count: 0, countTone: "need" },
          { value: "failed", label: "Problems", count: 0, countTone: "fail" },
        ]}
      />,
    );
    for (const name of ["Needs you, 0", "Problems, 0"]) {
      expect(tab(name).querySelector(".or-tab__count")!.className).toBe("or-tab__count");
    }
  });

  it("selects a tab on click and shows its panel", async () => {
    const { user, onValueChange } = setup();
    await user.click(tab("Failed, 1"));
    expect(onValueChange).toHaveBeenCalledWith("failed");
    expect(screen.getByRole("tabpanel").textContent).toBe("Failed panel");
  });

  it("keeps a keepMounted panel's state while another tab is selected, hidden", async () => {
    const user = userEvent.setup();
    render(
      <Tabs
        aria-label="Item views"
        tabs={[
          { value: "prd", label: "PRD" },
          { value: "activity", label: "Activity" },
        ]}
      >
        <TabPanel value="prd" keepMounted>
          <input aria-label="Draft" defaultValue="" />
        </TabPanel>
        <TabPanel value="activity">Activity panel</TabPanel>
      </Tabs>,
    );
    await user.type(screen.getByRole("textbox", { name: "Draft" }), "half a PRD");
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    const draft = screen.getByRole("textbox", { name: "Draft", hidden: true }) as HTMLInputElement;
    expect(draft.closest("[role=tabpanel]")!.hasAttribute("hidden")).toBe(true);
    await user.click(screen.getByRole("tab", { name: "PRD" }));
    expect((screen.getByRole("textbox", { name: "Draft" }) as HTMLInputElement).value).toBe(
      "half a PRD",
    );
    expect(draft.closest("[role=tabpanel]")!.hasAttribute("hidden")).toBe(false);
  });
});
