"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Muted,
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@iamthemcmaster/ui";
import { pageWindow } from "@/lib/pagination";

interface ListPaginationProps {
  /** 1-based current page. */
  page: number;
  pageCount: number;
  /** Link target of a page; also where it navigates unless `onSelect` is given. */
  hrefFor: (page: number) => string;
  /** Switches pages in place (client-side lists) instead of navigating. */
  onSelect?: (page: number) => void;
}

/**
 * Previous/next and page-number links; renders nothing for a single page. A navigation
 * shows the chosen page as current at once, and its link as pending until the page loads
 * (the list itself dims meanwhile: `.list-pending[aria-busy]`).
 */
export function ListPagination({ page, pageCount, hrefFor, onSelect }: ListPaginationProps) {
  const router = useRouter();
  const [navigating, startNavigation] = React.useTransition();
  const [target, setTarget] = React.useState<number | null>(null);
  if (pageCount <= 1) return null;
  const pendingPage = navigating ? target : null;
  const current = pendingPage ?? page;
  const go = (to: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    if (onSelect) return onSelect(to);
    setTarget(to);
    startNavigation(() => router.push(hrefFor(to)));
  };
  /** The props of the link to `to`: pending while its page loads. */
  const link = (to: number) => ({
    href: hrefFor(to),
    onClick: go(to),
    ...(pendingPage === to ? { "data-pending": "", "aria-busy": true } : {}),
  });
  return (
    <Pagination>
      <PaginationContent>
        {current > 1 && (
          <PaginationItem>
            <PaginationPrevious {...link(current - 1)} />
          </PaginationItem>
        )}
        {pageWindow(current, pageCount).map((p, i) =>
          p === "gap" ? (
            <PaginationItem key={`gap-${i}`}>
              <Muted>…</Muted>
            </PaginationItem>
          ) : (
            <PaginationItem key={p}>
              <PaginationLink {...link(p)} isActive={p === current}>
                {p}
              </PaginationLink>
            </PaginationItem>
          ),
        )}
        {current < pageCount && (
          <PaginationItem>
            <PaginationNext {...link(current + 1)} />
          </PaginationItem>
        )}
      </PaginationContent>
    </Pagination>
  );
}
