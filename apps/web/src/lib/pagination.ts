/**
 * Client-safe pagination helpers shared by the paginated lists (reviews,
 * repositories, GitHub installation repositories).
 */

/** A 1-based page number from a URL search param; anything else is page 1. */
export function parsePage(value: string | string[] | undefined): number {
  const page = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

/** Number of pages for `total` items (at least 1, so an empty list has one page). */
export function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** The 1-based range of items shown on `page`, e.g. "26–50 of 120". */
export function pageRange(
  page: number,
  pageSize: number,
  shown: number,
): { first: number; last: number } {
  const offset = (page - 1) * pageSize;
  return shown === 0 ? { first: 0, last: 0 } : { first: offset + 1, last: offset + shown };
}

/** The items on `page` of an in-memory list. */
export function pageSlice<T>(items: readonly T[], page: number, pageSize: number): T[] {
  return items.slice((page - 1) * pageSize, page * pageSize);
}

/** Page numbers to show: first, last and the current page's neighbours. */
export function pageWindow(page: number, pageCount: number): (number | "gap")[] {
  const pages = new Set([1, pageCount, page - 1, page, page + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  return sorted.flatMap((p, i) => (i > 0 && p - sorted[i - 1]! > 1 ? ["gap" as const, p] : [p]));
}
