import type { CSSProperties } from "react";
import { DetailsSection } from "../surfaces/details-section.js";

export interface BarChartDatum {
  /** Unique per bucket, e.g. its first day (`2026-10-05`). */
  key: string;
  /** The bucket's label, e.g. "Oct 5" or "Week of Oct 5": axis, bar title and table row. */
  label: string;
  /** The bucket's value; null draws no bar (e.g. a rate with nothing to rate). */
  value: number | null;
  /** The bucket's name in its bar's title when `label` is short for it, e.g. "Week of Oct 5". */
  title?: string;
  /** More about the value: a line after the bar's title and the table cell's tooltip. */
  note?: string;
}

export interface BarChartProps {
  /** What the chart shows, e.g. "Stories completed"; its caption and its table's caption. */
  title: string;
  /** One sentence summarizing the chart, written by the page: the chart's accessible name. */
  summary: string;
  data: readonly BarChartDatum[];
  /** Formats a value for the axis, the bar titles and the table, e.g. "12.3M" or "96%". */
  formatValue: (value: number) => string;
  /** A fixed axis maximum (e.g. 1 for rates); otherwise `niceMax` of the largest value. */
  max?: number;
  /** The plot's height in px. Defaults to 180 (140 at 768 px and narrower, from the CSS). */
  height?: number;
  /** The table's column headers: the bucket's (e.g. "Day") and the value's. */
  tableHeaders: readonly [bucketHeader: string, valueHeader: string];
  /** What the table says for a `null` value, e.g. "No attempts". Defaults to "—". */
  emptyValueText?: string;
  /** Hides the caption visually (it stays the figure's name), e.g. when a card title says it. */
  hideTitle?: boolean;
  className?: string;
}

/** The smallest 1, 2 or 5 × 10ⁿ at or above `max`; 1 for 0 (or less). */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) {
    // Rounded, so 0.3 × 10 doesn't come out as 3.0000000000000004.
    const candidate = Number((step * magnitude).toPrecision(12));
    if (candidate >= max) return candidate;
  }
  return 10 * magnitude;
}

/** A bar's share of its bucket's width; the rest is the gap between bars. */
const BAR_WIDTH = 0.7;

/** Which buckets name the x axis: the first, the middle and the last. */
function axisLabels(count: number): { index: number; position: "first" | "middle" | "last" }[] {
  if (count === 0) return [];
  if (count === 1) return [{ index: 0, position: "first" }];
  const labels: { index: number; position: "first" | "middle" | "last" }[] = [
    { index: 0, position: "first" },
  ];
  const middle = Math.floor((count - 1) / 2);
  if (middle > 0 && middle < count - 1) labels.push({ index: middle, position: "middle" });
  labels.push({ index: count - 1, position: "last" });
  return labels;
}

/**
 * Bars over buckets, in plain SVG: one `rect` per bucket with a value, its height
 * proportional to `value / max` (the fixed `max`, else `niceMax` of the largest value), in
 * the neutral `--or-sec` (`--or-text` on hover); never the accent or a status color. The
 * SVG stretches to the width (`preserveAspectRatio="none"`), so its text (the 0 and maximum
 * ticks, the first, middle and last bucket labels) is HTML around it and never stretches.
 * The SVG is an `img` named by `summary`, each bar carries a `<title>` ("Oct 12: 7", then
 * the datum's `note`), and a collapsed "Show table" holds every bucket and its value.
 */
export function BarChart({
  title,
  summary,
  data,
  formatValue,
  max,
  height,
  tableHeaders,
  emptyValueText = "—",
  hideTitle = false,
  className,
}: BarChartProps) {
  const count = data.length;
  const largest = data.reduce((high, datum) => Math.max(high, datum.value ?? 0), 0);
  const top = max ?? niceMax(largest);
  const style =
    height === undefined ? undefined : ({ "--or-chart-height": `${height}px` } as CSSProperties);
  return (
    <figure className={["or-chart", className].filter(Boolean).join(" ")} style={style}>
      <figcaption className={hideTitle ? "or-sr-only" : "or-chart__title"}>{title}</figcaption>
      <div className="or-chart__plot">
        <div className="or-chart__y" aria-hidden="true">
          <span className="or-chart__tick">{formatValue(top)}</span>
          <span className="or-chart__tick">{formatValue(0)}</span>
        </div>
        <div className="or-chart__area">
          <svg
            className="or-chart__svg"
            role="img"
            aria-label={summary}
            viewBox={`0 0 ${Math.max(count, 1)} 100`}
            preserveAspectRatio="none"
          >
            {data.map((datum, index) => {
              if (datum.value === null) return null;
              const barHeight = Math.min(Math.max(datum.value / top, 0), 1) * 100;
              return (
                <rect
                  key={datum.key}
                  className="or-chart__bar"
                  x={index + (1 - BAR_WIDTH) / 2}
                  y={100 - barHeight}
                  width={BAR_WIDTH}
                  height={barHeight}
                >
                  <title>
                    {`${datum.title ?? datum.label}: ${formatValue(datum.value)}`}
                    {datum.note ? `\n${datum.note}` : null}
                  </title>
                </rect>
              );
            })}
          </svg>
          <div className="or-chart__x" aria-hidden="true">
            {axisLabels(count).map(({ index, position }) => (
              <span
                key={position}
                className={`or-chart__label or-chart__label--${position}`}
                // The first label starts at the plot's left edge, the last ends at its right.
                style={
                  position === "middle" ? { left: `${((index + 0.5) / count) * 100}%` } : undefined
                }
              >
                {data[index]!.label}
              </span>
            ))}
          </div>
        </div>
      </div>
      <DetailsSection title="Show table" className="or-chart__details">
        <table className="or-tbl or-chart__table">
          <caption className="or-sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col">{tableHeaders[0]}</th>
              <th scope="col" className="or-tbl__cell--end">
                {tableHeaders[1]}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.map((datum) => (
              <tr key={datum.key}>
                <th scope="row">{datum.label}</th>
                <td className="or-tbl__cell--end or-mono" title={datum.note}>
                  {datum.value === null ? emptyValueText : formatValue(datum.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DetailsSection>
    </figure>
  );
}
