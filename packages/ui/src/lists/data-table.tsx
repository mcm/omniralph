"use client";

import type { ReactNode } from "react";
import { useLinkComponent } from "../provider/ui-provider.js";

/**
 * Where a column goes on the phone card: the top line (`status`, `time`), the `title`,
 * the `meta` badges under it, or nowhere (`hidden`).
 */
export type CardSlot = "title" | "meta" | "status" | "time" | "hidden";

export interface DataTableColumn<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** The column's place on the phone card. Defaults to `meta`. */
  card?: CardSlot;
  align?: "start" | "center" | "end";
  /** Machine facts (IDs, SHAs, durations, timestamps) in Geist Mono. */
  mono?: boolean;
}

/** A row's tone: `bad` tints it with `--or-fail-tint`. */
export type RowTone = "bad";

export interface DataTableProps<T> {
  rows: readonly T[];
  getRowId: (row: T) => string;
  columns: readonly DataTableColumn<T>[];
  /** Names the table for assistive tech; visually hidden. */
  caption: string;
  /** Links each row: the title cell (table) and the card title (phone) hold the link. */
  getRowHref?: (row: T) => string;
  /** The row shown in the detail view; marked `aria-current="true"`. */
  selectedId?: string;
  rowTone?: (row: T) => RowTone | undefined;
  className?: string;
}

function cx(...classes: (string | false | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * A real table on wider screens and the same rows as stacked cards at 768 px and
 * narrower (Design rule 16). With `getRowHref`, the title is the row's one link and a
 * click anywhere on the row follows it; buttons and checkboxes in other cells stay
 * siblings of the link, never inside it.
 */
export function DataTable<T>({
  rows,
  getRowId,
  columns,
  caption,
  getRowHref,
  selectedId,
  rowTone,
  className,
}: DataTableProps<T>) {
  const Link = useLinkComponent();
  const titleColumn = columns.find((column) => column.card === "title") ?? columns[0];
  const slot = (column: DataTableColumn<T>): CardSlot =>
    column === titleColumn ? "title" : column.card === "title" ? "meta" : (column.card ?? "meta");
  const inSlot = (name: CardSlot) => columns.filter((column) => slot(column) === name);
  const topColumns = columns.filter((column) => ["status", "time"].includes(slot(column)));
  const metaColumns = inSlot("meta");

  const rowState = (row: T) => {
    const id = getRowId(row);
    return {
      id,
      href: getRowHref?.(row),
      selected: selectedId !== undefined && id === selectedId,
      bad: rowTone?.(row) === "bad",
    };
  };

  const title = (row: T, href: string | undefined, className: string) =>
    href === undefined ? (
      titleColumn?.cell(row)
    ) : (
      <Link href={href} className={className}>
        {titleColumn?.cell(row)}
      </Link>
    );

  return (
    <div className={cx("or-data-table", className)}>
      <div className="or-tblwrap">
        <table className="or-tbl">
          <caption className="or-sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  className={cx(column.align && `or-tbl__cell--${column.align}`)}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const { id, href, selected, bad } = rowState(row);
              return (
                <tr
                  key={id}
                  className={cx(
                    "or-tbl__row",
                    href !== undefined && "or-tbl__row--linked",
                    bad && "or-tbl__row--bad",
                  )}
                  aria-current={selected ? "true" : undefined}
                >
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={cx(
                        column === titleColumn && "or-tbl__title",
                        column.align && `or-tbl__cell--${column.align}`,
                        column.mono && "or-mono",
                      )}
                    >
                      {column === titleColumn ? title(row, href, "or-row-link") : column.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="or-cards" aria-label={caption}>
        {rows.map((row) => {
          const { id, href, selected, bad } = rowState(row);
          return (
            <li
              key={id}
              className={cx(
                "or-cardrow",
                href !== undefined && "or-cardrow--linked",
                bad && "or-cardrow--bad",
              )}
              aria-current={selected ? "true" : undefined}
            >
              {topColumns.length > 0 ? (
                <div className="or-cardrow__top">
                  {topColumns.map((column) => (
                    <span
                      key={column.id}
                      className={cx(
                        `or-cardrow__${slot(column)}`,
                        (column.mono || slot(column) === "time") && "or-mono",
                      )}
                    >
                      {column.cell(row)}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className={cx("or-cardrow__title", titleColumn?.mono && "or-mono")}>
                {title(row, href, "or-row-link")}
              </div>
              {metaColumns.length > 0 ? (
                <div className="or-cardrow__meta">
                  {metaColumns.map((column) => (
                    <span key={column.id} className={cx(column.mono && "or-mono")}>
                      {column.cell(row)}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
