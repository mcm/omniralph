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

/** Previous/next and page-number links; renders nothing for a single page. */
export function ListPagination({ page, pageCount, hrefFor, onSelect }: ListPaginationProps) {
  const router = useRouter();
  if (pageCount <= 1) return null;
  const go = (target: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    if (onSelect) onSelect(target);
    else router.push(hrefFor(target));
  };
  return (
    <Pagination>
      <PaginationContent>
        {page > 1 && (
          <PaginationItem>
            <PaginationPrevious href={hrefFor(page - 1)} onClick={go(page - 1)} />
          </PaginationItem>
        )}
        {pageWindow(page, pageCount).map((p, i) =>
          p === "gap" ? (
            <PaginationItem key={`gap-${i}`}>
              <Muted>…</Muted>
            </PaginationItem>
          ) : (
            <PaginationItem key={p}>
              <PaginationLink href={hrefFor(p)} isActive={p === page} onClick={go(p)}>
                {p}
              </PaginationLink>
            </PaginationItem>
          ),
        )}
        {page < pageCount && (
          <PaginationItem>
            <PaginationNext href={hrefFor(page + 1)} onClick={go(page + 1)} />
          </PaginationItem>
        )}
      </PaginationContent>
    </Pagination>
  );
}
