"use client";

import * as React from "react";
import { cn, TableCell, TableRow } from "@iamthemcmaster/ui";

/**
 * A failed row's reason on its own line under the row, across its full width. It is
 * clamped to two lines; when it is longer, "Show all" (a button, so keyboard and touch
 * reach it) expands it in place.
 */
export function ListErrorRow({ error, colSpan }: { error: string; colSpan: number }) {
  return (
    <TableRow className="list-error-row">
      <TableCell colSpan={colSpan}>
        <ListError error={error} />
      </TableCell>
    </TableRow>
  );
}

export function ListError({ error }: { error: string }) {
  const id = React.useId();
  const ref = React.useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [clamped, setClamped] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [error, expanded]);

  return (
    <div className="list-error-line">
      <span id={id} ref={ref} className={cn("list-error", expanded && "list-error-expanded")}>
        {error}
      </span>
      {(clamped || expanded) && (
        <button
          type="button"
          className="list-error-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}
