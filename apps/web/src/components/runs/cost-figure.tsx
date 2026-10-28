"use client";

import { Tooltip } from "@omniralph/ui";
import { COST_NOTE, formatUsd } from "@/lib/cost/format";

/**
 * A list price ("$4.10", "<$0.01") with what it means as its tooltip (and `title`, as a
 * fallback). Neutral text, like the tokens beside it; callers render nothing without a figure.
 */
export function CostFigure({ usd }: { usd: number }) {
  return (
    <Tooltip content={COST_NOTE}>
      <span className="or-mono" title={COST_NOTE} tabIndex={0}>
        {formatUsd(usd)}
      </span>
    </Tooltip>
  );
}
