"use client";

import { useId, type ReactNode } from "react";

export interface SummaryCell {
  id: string;
  /** The cell's label, e.g. "Health"; it names the cell's `group`. */
  label: string;
  /** The headline, e.g. "6 of 7 online · 1 offline". */
  value: ReactNode;
  /** A line under the value, e.g. "1 busy" or an "Edit" link. */
  detail?: ReactNode;
  /** Drawn right after the label, e.g. an `InfoPopover` or the change history ⓘ. */
  info?: ReactNode;
}

export interface SummaryCellsProps {
  cells: readonly SummaryCell[];
  /** Names the card as a `region` when given, e.g. "Summary". */
  "aria-label"?: string;
  className?: string;
}

/**
 * The one summary card: cells side by side in a single card, wrapping to two columns at
 * 768 px and narrower. Each cell is a `group` named by its label, with an optional `info`
 * slot after the label and a `detail` line under the value.
 */
export function SummaryCells({ cells, "aria-label": ariaLabel, className }: SummaryCellsProps) {
  const id = useId();
  const Root = ariaLabel ? "section" : "div";
  return (
    <Root
      className={["or-card", "or-stats", className].filter(Boolean).join(" ")}
      aria-label={ariaLabel}
    >
      {cells.map((cell) => {
        const labelId = `${id}-${cell.id}`;
        return (
          <div key={cell.id} className="or-stats__cell" role="group" aria-labelledby={labelId}>
            <div className="or-stats__head">
              <span id={labelId} className="or-stats__label">
                {cell.label}
              </span>
              {cell.info}
            </div>
            <div className="or-stats__value">{cell.value}</div>
            {cell.detail !== undefined ? (
              <div className="or-stats__detail">{cell.detail}</div>
            ) : null}
          </div>
        );
      })}
    </Root>
  );
}
