"use client";

import { useId, type ReactNode } from "react";
import { Checkbox } from "../controls/checkbox.js";
import { useLinkComponent } from "../provider/ui-provider.js";
import { StatusDot, type StatusTone } from "../status/status.js";

export interface ListRowSelect {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The checkbox's accessible name, e.g. "Select fix-login". */
  label: string;
}

export interface ListRowProps {
  /** Where the row leads; the whole row is clickable. */
  href: string;
  /** The row's name; it names the row link. Clamped to two lines. */
  title: ReactNode;
  /** The kind and state, e.g. "Request · failed"; it also names the status dot. */
  kindLabel: string;
  tone: StatusTone;
  /** A short time ("4m", "2h") in a fixed-width mono slot. */
  time?: ReactNode;
  /** Reference badges under the title. */
  meta?: ReactNode;
  /** The row shown in the detail view; marked `aria-current="true"`. */
  selected?: boolean;
  /** A checkbox before the row link, for bulk actions. */
  select?: ListRowSelect;
  /** Buttons after the row link (e.g. an `IconButton`). */
  actions?: ReactNode;
  className?: string;
}

/**
 * One row of a `RowList`. A row link stretched over the whole row (named by the title)
 * makes it clickable, while the checkbox and the actions are its siblings, so each stays
 * independently focusable and clickable. Tab order: checkbox, row link, actions.
 */
export function ListRow({
  href,
  title,
  kindLabel,
  tone,
  time,
  meta,
  selected = false,
  select,
  actions,
  className,
}: ListRowProps) {
  const Link = useLinkComponent();
  const titleId = useId();
  return (
    <li
      className={["or-row", className].filter(Boolean).join(" ")}
      aria-current={selected ? "true" : undefined}
    >
      {select !== undefined ? (
        <Checkbox
          className="or-row__select"
          aria-label={select.label}
          checked={select.checked}
          onCheckedChange={select.onChange}
        />
      ) : null}
      <Link href={href} className="or-row__link" aria-labelledby={titleId} />
      <StatusDot className="or-row__dot" tone={tone} label={kindLabel} />
      <div className="or-row__main">
        <span className="or-row__kind" aria-hidden="true">
          {kindLabel}
        </span>
        <span id={titleId} className="or-row__title">
          {title}
        </span>
        {meta !== undefined ? <div className="or-row__meta">{meta}</div> : null}
      </div>
      <span className="or-row__time or-mono">{time}</span>
      {actions !== undefined ? <div className="or-row__actions">{actions}</div> : null}
    </li>
  );
}

export interface RowListProps {
  /** Names the list, e.g. "Needs you". */
  "aria-label": string;
  /** `ListRow`s. */
  children?: ReactNode;
  className?: string;
}

/** A `<ul>` of `ListRow`s. */
export function RowList({ "aria-label": label, children, className }: RowListProps) {
  return (
    <ul className={["or-rows", className].filter(Boolean).join(" ")} aria-label={label}>
      {children}
    </ul>
  );
}
