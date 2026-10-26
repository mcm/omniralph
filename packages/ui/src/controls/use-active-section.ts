"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * The band of the scroll root that counts as "in view": its top 40%. A section is the
 * candidate while any part of it is in that band.
 */
export const ACTIVE_SECTION_ROOT_MARGIN = "0px 0px -60% 0px";

/**
 * The id of the section nearest the top of the scroll root (`rootRef`, or the viewport when
 * it is null), followed with an `IntersectionObserver`. Of the sections in the top band the
 * first in `ids` order wins; when none is in the band the last answer stays. Starts at the
 * first id.
 */
export function useActiveSection<Id extends string>(
  ids: readonly Id[],
  rootRef?: RefObject<Element | null>,
): Id | null {
  const [active, setActive] = useState<Id | null>(ids[0] ?? null);
  const key = ids.join("\u0000");

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const sectionIds = key === "" ? [] : (key.split("\u0000") as Id[]);
    const inBand = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) inBand.add(entry.target.id);
          else inBand.delete(entry.target.id);
        }
        const first = sectionIds.find((id) => inBand.has(id));
        if (first !== undefined) setActive(first);
      },
      { root: rootRef?.current ?? null, rootMargin: ACTIVE_SECTION_ROOT_MARGIN, threshold: 0 },
    );
    for (const id of sectionIds) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [key, rootRef]);

  // A changed list keeps the answer only while it still names a section.
  if (active !== null && !ids.includes(active)) {
    const next = ids[0] ?? null;
    if (next !== active) setActive(next);
    return next;
  }
  return active;
}
