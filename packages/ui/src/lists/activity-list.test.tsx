import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ActivityList, activityDate, type ActivityEntry } from "./activity-list.js";

const entries = (n: number): ActivityEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    at: new Date(2026, 9, 24, 14, i),
    text: `Entry ${i}`,
  }));

describe("activityDate", () => {
  it("formats the local date and 24-hour time", () => {
    expect(activityDate(new Date(2026, 9, 24, 14, 2))).toBe("Oct 24 14:02");
    expect(activityDate(new Date(2026, 0, 3, 9, 5).toISOString())).toBe("Jan 3 09:05");
  });

  it("returns an empty string for an invalid date", () => {
    expect(activityDate("not a date")).toBe("");
  });
});

describe("ActivityList", () => {
  it("renders a named ordered list with a mono date column and the sentence", () => {
    render(
      <ActivityList
        entries={[{ id: "a", at: "2026-10-24T14:02:00.000Z", text: <b>Story finished</b> }]}
      />,
    );
    const list = screen.getByRole("list", { name: "Activity" });
    expect(list.tagName).toBe("OL");
    const [item] = within(list).getAllByRole("listitem");
    const time = item!.querySelector("time")!;
    expect(time.className).toBe("or-activity__date or-mono");
    expect(time.getAttribute("dateTime")).toBe("2026-10-24T14:02:00.000Z");
    expect(time.textContent).toBe(activityDate("2026-10-24T14:02:00.000Z"));
    expect(within(item!).getByText("Story finished").tagName).toBe("B");
  });

  it("shows every entry and no button at ten or fewer", () => {
    render(<ActivityList entries={entries(10)} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows ten entries then Show all {n}, which reveals the rest", async () => {
    const user = userEvent.setup();
    render(<ActivityList entries={entries(14)} aria-label="Run activity" />);
    const list = screen.getByRole("list", { name: "Run activity" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(entries(10).map((entry) => `${activityDate(entry.at)}${entry.text as string}`));
    await user.click(screen.getByRole("button", { name: "Show all 14" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(14);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("takes a custom limit", () => {
    render(<ActivityList entries={entries(4)} limit={2} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Show all 4" })).toBeTruthy();
  });
});
