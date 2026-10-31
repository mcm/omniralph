"use client";

import { useId, type MouseEventHandler, type ReactNode } from "react";
import { Checkbox } from "../controls/checkbox.js";
import { useLinkComponent } from "../provider/ui-provider.js";
import { rowLinkProps, rowListProps } from "../shortcuts/row-links.js";
import { StatusDot, type StatusTone } from "../status/status.js";
import { RowAvatar, type RowStatus } from "./row-avatar.js";

export interface ListRowSelect {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The checkbox's accessible name, e.g. "Select fix-login". */
  label: string;
}

/** A row led by a status dot and its kind above the title. */
interface ListRowStatus {
  avatar?: never;
  status?: never;
  /** The line above the title, e.g. "Request"; it names the status dot unless `statusLabel` does. */
  kindLabel: string;
  /**
   * Names the status dot when the kind line leaves the state to the dot's color, e.g.
   * "Request, failed". Defaults to `kindLabel`.
   */
  statusLabel?: string;
  tone: StatusTone;
  mark?: never;
}

/** A row led by a mark (e.g. a work item's tracker `BrandMark`), with no dot and no kind line. */
interface ListRowMark {
  /** Replaces the status dot; it names itself (a `BrandMark` is `role="img"`). */
  mark: ReactNode;
  kindLabel?: never;
  statusLabel?: never;
  tone?: never;
  avatar?: never;
  status?: never;
}

/**
 * A list pane's row (one with a detail pane alongside), led by a `RowAvatar`: what the row is,
 * with its state as a dot on the corner. An optional line above the title says why it's
 * listed (the Inbox's "Question").
 */
interface ListRowAvatar {
  /** The avatar's icon or mark. */
  avatar: ReactNode;
  /** The row's state, a dot on the avatar. */
  status?: RowStatus;
  /** A line above the title, e.g. why the row is listed. */
  kindLabel?: string;
  statusLabel?: never;
  tone?: never;
  mark?: never;
}

export type ListRowProps = (ListRowStatus | ListRowMark | ListRowAvatar) & {
  /** Where the row leads; the whole row is clickable. */
  href: string;
  /**
   * Called on a click on the row link, e.g. to open the row in a panel instead
   * (`event.preventDefault()` keeps the link from navigating).
   */
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  /** The row's name; it names the row link. Clamped to two lines. */
  title: ReactNode;
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
};

/**
 * One row of a `RowList`. A row link stretched over the whole row (named by the title)
 * makes it clickable, while the checkbox and the actions are its siblings, so each stays
 * independently focusable and clickable. Tab order: checkbox, row link, actions.
 */
export function ListRow({
  href,
  onClick,
  title,
  kindLabel,
  statusLabel,
  tone,
  mark,
  avatar,
  status,
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
      <Link
        {...rowLinkProps}
        href={href}
        onClick={onClick}
        className="or-row__link"
        aria-labelledby={titleId}
      />
      {avatar !== undefined ? (
        <RowAvatar className="or-row__avatar" status={status}>
          {avatar}
        </RowAvatar>
      ) : tone !== undefined ? (
        <StatusDot className="or-row__dot" tone={tone} label={statusLabel ?? kindLabel} />
      ) : (
        <span className="or-row__mark">{mark}</span>
      )}
      <div className="or-row__main">
        {kindLabel !== undefined ? (
          // Beside a dot it repeats the dot's name; beside an avatar it's the only place it shows.
          <span className="or-row__kind" aria-hidden={avatar === undefined ? "true" : undefined}>
            {kindLabel}
          </span>
        ) : null}
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

/** A `<ul>` of `ListRow`s; Next item and Previous item move between its row links. */
export function RowList({ "aria-label": label, children, className }: RowListProps) {
  return (
    <ul
      {...rowListProps}
      className={["or-rows", className].filter(Boolean).join(" ")}
      aria-label={label}
    >
      {children}
    </ul>
  );
}
