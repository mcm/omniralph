import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { BarChart, niceMax, type BarChartDatum } from "./bar-chart.js";

const days: BarChartDatum[] = [
  { key: "2026-10-03", label: "Oct 3", value: 4 },
  { key: "2026-10-04", label: "Oct 4", value: 0 },
  { key: "2026-10-05", label: "Oct 5", value: 7 },
  { key: "2026-10-06", label: "Oct 6", value: null },
  { key: "2026-10-07", label: "Oct 7", value: 2 },
];

function renderChart(props: Partial<Parameters<typeof BarChart>[0]> = {}) {
  return render(
    <BarChart
      title="Stories completed"
      summary="Stories completed per day, Oct 3 to Oct 7: 13 in total, most on Oct 5 (7)"
      data={days}
      formatValue={(value) => String(value)}
      tableHeaders={["Day", "Stories completed"]}
      {...props}
    />,
  );
}

describe("niceMax", () => {
  it("rounds up to 1, 2 or 5 × 10ⁿ", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-3)).toBe(1);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(1.2)).toBe(2);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(10)).toBe(10);
    expect(niceMax(42)).toBe(50);
    expect(niceMax(150)).toBe(200);
    expect(niceMax(12_300_000)).toBe(20_000_000);
    expect(niceMax(0.27)).toBe(0.5);
    expect(niceMax(0.3)).toBe(0.5);
    expect(niceMax(0.2)).toBe(0.2);
  });
});

describe("BarChart", () => {
  it("is a figure whose SVG is an image named by the summary", () => {
    const { container } = renderChart();
    const figure = container.querySelector("figure.or-chart")!;
    expect(figure).not.toBeNull();
    const image = screen.getByRole("img", {
      name: "Stories completed per day, Oct 3 to Oct 7: 13 in total, most on Oct 5 (7)",
    });
    expect(image.tagName.toLowerCase()).toBe("svg");
    expect(image.getAttribute("viewBox")).toBe("0 0 5 100");
    expect(image.getAttribute("preserveAspectRatio")).toBe("none");
    expect(figure.querySelector("figcaption")!.textContent).toBe("Stories completed");
  });

  it("draws one bar per bucket with a value, scaled to niceMax, each with a title", () => {
    const { container } = renderChart();
    const bars = [...container.querySelectorAll("rect.or-chart__bar")];
    // The null bucket has no bar; the zero bucket has an empty one.
    expect(bars).toHaveLength(4);
    expect(bars.map((bar) => bar.querySelector("title")!.textContent)).toEqual([
      "Oct 3: 4",
      "Oct 4: 0",
      "Oct 5: 7",
      "Oct 7: 2",
    ]);
    // niceMax(7) is 10: 7 is 70% of the plot, 4 is 40%.
    expect(Number(bars[2]!.getAttribute("height"))).toBeCloseTo(70);
    expect(Number(bars[2]!.getAttribute("y"))).toBeCloseTo(30);
    expect(Number(bars[0]!.getAttribute("height"))).toBeCloseTo(40);
    expect(Number(bars[1]!.getAttribute("height"))).toBe(0);
    // Each bar sits in its bucket's slot: the fourth bar is the fifth bucket.
    expect(Number(bars[3]!.getAttribute("x"))).toBeGreaterThan(4);
    expect(Number(bars[3]!.getAttribute("x"))).toBeLessThan(5);
  });

  it("uses a fixed maximum when given", () => {
    const { container } = renderChart({
      data: [
        { key: "a", label: "Oct 3", value: 0.8 },
        { key: "b", label: "Oct 4", value: 1 },
      ],
      max: 1,
      formatValue: (value) => `${Math.round(value * 100)}%`,
    });
    const bars = [...container.querySelectorAll("rect.or-chart__bar")];
    expect(Number(bars[0]!.getAttribute("height"))).toBeCloseTo(80);
    expect(Number(bars[1]!.getAttribute("height"))).toBeCloseTo(100);
    expect([...container.querySelectorAll(".or-chart__tick")].map((t) => t.textContent)).toEqual([
      "100%",
      "0%",
    ]);
  });

  it("labels 0 and the rounded maximum, and the first, middle and last bucket, as HTML", () => {
    const { container } = renderChart();
    const ticks = [...container.querySelectorAll(".or-chart__tick")];
    expect(ticks.map((tick) => tick.textContent)).toEqual(["10", "0"]);
    expect(ticks.every((tick) => tick.closest("svg") === null)).toBe(true);
    const labels = [...container.querySelectorAll(".or-chart__label")];
    expect(labels.map((label) => label.textContent)).toEqual(["Oct 3", "Oct 5", "Oct 7"]);
    expect(labels.map((label) => label.className)).toEqual([
      "or-chart__label or-chart__label--first",
      "or-chart__label or-chart__label--middle",
      "or-chart__label or-chart__label--last",
    ]);
    expect((labels[1] as HTMLElement).style.left).toBe("50%");
    // Neither ticks nor labels are read out: the summary and the table say it.
    expect(container.querySelector(".or-chart__y")!.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".or-chart__x")!.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("svg text")).toBeNull();
  });

  it("holds every bucket in a collapsed, captioned table", async () => {
    const user = userEvent.setup();
    const { container } = renderChart({ emptyValueText: "No attempts" });
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getByText("Show table").tagName).toBe("SUMMARY");
    await user.click(within(details).getByText("Show table"));
    const table = screen.getByRole("table", { name: "Stories completed" });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual(["Day", "Stories completed"]);
    expect(headers.every((header) => header.getAttribute("scope") === "col")).toBe(true);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(days.length);
    expect(rows.map((row) => row.textContent)).toEqual([
      "Oct 34",
      "Oct 40",
      "Oct 57",
      "Oct 6No attempts",
      "Oct 72",
    ]);
    expect(within(rows[0]!).getByRole("rowheader").getAttribute("scope")).toBe("row");
  });

  it("says — for a missing value by default, and can hide its caption", () => {
    const { container } = renderChart({ hideTitle: true });
    expect(container.querySelector("tbody tr:nth-child(4) td")!.textContent).toBe("—");
    expect(container.querySelector("figcaption")!.className).toBe("or-sr-only");
  });

  it("sets the plot height only when given (the CSS defaults to 180, 140 on phone)", () => {
    const { container, rerender } = renderChart();
    const figure = container.querySelector("figure") as HTMLElement;
    expect(figure.style.getPropertyValue("--or-chart-height")).toBe("");
    rerender(
      <BarChart
        title="Tokens in"
        summary="s"
        data={days}
        formatValue={String}
        tableHeaders={["Day", "Tokens in"]}
        height={120}
      />,
    );
    expect(figure.style.getPropertyValue("--or-chart-height")).toBe("120px");
  });

  it("names a bar by its title and adds its note, which the table cell carries too", () => {
    const { container } = renderChart({
      data: [
        { key: "w1", label: "Sep 28", title: "Week of Sep 28", value: 3, note: "List prices" },
        { key: "w2", label: "Oct 5", title: "Week of Oct 5", value: 1 },
      ],
    });
    const titles = [...container.querySelectorAll("rect title")].map((t) => t.textContent);
    expect(titles).toEqual(["Week of Sep 28: 3\nList prices", "Week of Oct 5: 1"]);
    const cells = [...container.querySelectorAll("tbody td")];
    expect(cells.map((cell) => cell.getAttribute("title"))).toEqual(["List prices", null]);
    // The table row and the axis use the short label.
    expect(container.querySelector("tbody th")!.textContent).toBe("Sep 28");
  });

  it("draws nothing for no buckets", () => {
    const { container } = renderChart({ data: [] });
    expect(container.querySelectorAll("rect")).toHaveLength(0);
    expect(container.querySelectorAll(".or-chart__label")).toHaveLength(0);
  });
});
