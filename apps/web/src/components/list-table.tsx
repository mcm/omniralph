import type * as React from "react";
import { Button } from "@iamthemcmaster/ui";
import { IconExternalLink } from "@tabler/icons-react";
import {
  formatDateTime,
  formatDateTimeAfter,
  formatDateTimeInYear,
  formatRelative,
} from "@/lib/format-date";

/** Class of the table cells hidden below 768px; their row's first cell shows `PhoneMeta`. */
export const WIDE_COLUMN = "list-col-wide";

/**
 * A timestamp in mono numerals on one line. Every rendered `formatDateTime` or
 * `formatRelative` goes through it (the `design-system/no-bare-timestamp` lint
 * rule). `inline` keeps the surrounding text's size and color (facts,
 * sentences); the default is a table's small secondary time. With `now` it
 * shows the relative time ("5 min ago") and the exact one in its title. With
 * `after` (an earlier timestamp shown beside it, e.g. a job's created time next to
 * its finished one) it drops the date parts they share, and with `year` (the current
 * one) it drops the year when it is that; the full value is in its title.
 */
export function Timestamp({
  iso,
  inline,
  now,
  after,
  year,
}: {
  iso: string;
  inline?: boolean;
  now?: number;
  after?: string;
  year?: number;
}) {
  const exact = formatDateTime(iso);
  const text =
    now !== undefined
      ? formatRelative(iso, now)
      : after !== undefined
        ? formatDateTimeAfter(iso, after)
        : year !== undefined
          ? formatDateTimeInYear(iso, year)
          : exact;
  return (
    <time
      dateTime={iso}
      className={`${inline ? "mono-time" : "list-time"} text-numeric`}
      title={text === exact ? undefined : exact}
    >
      {text}
    </time>
  );
}

/**
 * The row's status and time, shown under its title below 768px where the
 * columns holding them are hidden.
 */
export function PhoneMeta({ children }: { children: React.ReactNode }) {
  return <div className="list-phone-meta">{children}</div>;
}

/** A row's trailing link out of the panel (Linear, PR/MR, code host). */
export function ExternalRowLink({
  href,
  label,
  className,
}: {
  href: string;
  label: string;
  /** E.g. `list-label-wide` to hide it below 768px when the row's menu has the link too. */
  className?: string;
}) {
  return (
    <Button
      asChild
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      className={className}
    >
      <a href={href} target="_blank" rel="noreferrer">
        <IconExternalLink size={14} />
      </a>
    </Button>
  );
}
