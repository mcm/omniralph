"use client";

import * as React from "react";

/**
 * The id of the highlighted `CommandItem` in a list, for `aria-activedescendant` on an input
 * that cmdk doesn't own. cmdk gives items generated ids and marks the highlighted one with
 * `aria-selected`, so this watches the list for that attribute. Pass the returned ref to
 * `CommandList`.
 */
export function useActiveOption(): [string | undefined, (list: HTMLElement | null) => void] {
  const [activeId, setActiveId] = React.useState<string>();
  const observer = React.useRef<MutationObserver | null>(null);

  const ref = React.useCallback((list: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!list) {
      setActiveId(undefined);
      return;
    }
    const read = () =>
      setActiveId(list.querySelector('[cmdk-item][aria-selected="true"]')?.id || undefined);
    read();
    observer.current = new MutationObserver(read);
    observer.current.observe(list, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-selected"],
    });
  }, []);

  React.useEffect(() => () => observer.current?.disconnect(), []);
  return [activeId, ref];
}
