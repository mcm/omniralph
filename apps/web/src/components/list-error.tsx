"use client";

import * as React from "react";
import { cn, TableCell, TableRow } from "@iamthemcmaster/ui";

/**
 * The id a failed row's status cell names in `aria-describedby`, so a screen reader reads
 * the reason with the status; pass the same id to `ListErrorRow`. Undefined when the row
 * has no error.
 */
export function useListErrorId(error: string | null | undefined): string | undefined {
  const id = React.useId();
  return error ? id : undefined;
}

/**
 * A failed row's reason on its own line under the row, across its full width. It is
 * clamped to two lines; when it is longer, "Show all" (a button, so keyboard and touch
 * reach it) expands it in place. `id` (from `useListErrorId`) ties it to the failed row;
 * `targeted` carries that row's link highlight onto it.
 */
export function ListErrorRow({
  error,
  colSpan,
  id,
  targeted,
}: {
  error: string;
  colSpan: number;
  id?: string;
  targeted?: boolean;
}) {
  return (
    <TableRow className="list-error-row" data-targeted={targeted || undefined}>
      <TableCell colSpan={colSpan}>
        <ListError error={error} id={id} />
      </TableCell>
    </TableRow>
  );
}

export function ListError({ error, id: idProp }: { error: string; id?: string }) {
  const ownId = React.useId();
  const id = idProp ?? ownId;
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
