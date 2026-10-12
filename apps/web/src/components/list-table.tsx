import type * as React from "react";
import { Button } from "@iamthemcmaster/ui";
import { IconExternalLink } from "@tabler/icons-react";
import { formatDateTime } from "@/lib/format-date";

/** Class of the table cells hidden below 768px; their row's first cell shows `PhoneMeta`. */
export const WIDE_COLUMN = "list-col-wide";

/** A timestamp in mono numerals on one line. */
export function Timestamp({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} className="list-time text-numeric">
      {formatDateTime(iso)}
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
