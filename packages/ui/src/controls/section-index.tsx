"use client";

import type { MouseEvent } from "react";
import { useLinkComponent } from "../provider/ui-provider.js";

export interface SectionIndexEntry<Id extends string = string> {
  /** The section element's `id`; the entry links to `#<id>`. */
  id: Id;
  label: string;
}

export interface SectionIndexProps<Id extends string = string> {
  sections: readonly SectionIndexEntry<Id>[];
  /** The section in view (e.g. from `useActiveSection`); its entry gets `aria-current`. */
  active?: Id | null;
  /** Called with the entry's id when it is clicked, before the section scrolls into view. */
  onNavigate?: (id: Id) => void;
  /** Names the `nav` landmark, e.g. "Sections". */
  "aria-label": string;
  className?: string;
}

/**
 * Moves to a section on the page: scrolls it to the top and focuses its first heading (or
 * the section itself), making it focusable with `tabindex="-1"` when it isn't already.
 */
export function scrollToSection(id: string): void {
  const section = document.getElementById(id);
  if (!section) return;
  section.scrollIntoView({ block: "start" });
  const target = section.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6") ?? section;
  if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

/**
 * In-page links to the sections of one long page, drawn like `Tabs` (every section stays
 * rendered, so this is a `nav`, not a tab list). Clicking an entry calls `onNavigate`,
 * scrolls its section into view and moves focus to the section's heading. The strip
 * scrolls horizontally instead of wrapping.
 */
export function SectionIndex<Id extends string = string>({
  sections,
  active,
  onNavigate,
  "aria-label": ariaLabel,
  className,
}: SectionIndexProps<Id>) {
  const Link = useLinkComponent();

  function navigate(event: MouseEvent<HTMLAnchorElement>, id: Id) {
    // Modified clicks keep the browser's behavior (e.g. a new tab).
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate?.(id);
    scrollToSection(id);
  }

  return (
    <nav
      className={["or-section-index", className].filter(Boolean).join(" ")}
      aria-label={ariaLabel}
    >
      <ul className="or-tabs or-section-index__list">
        {sections.map((section) => (
          <li key={section.id} className="or-section-index__item">
            <Link
              href={`#${section.id}`}
              className="or-tab"
              aria-current={section.id === active ? "true" : undefined}
              onClick={(event: MouseEvent<HTMLAnchorElement>) => navigate(event, section.id)}
            >
              {section.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
