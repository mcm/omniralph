"use client";

import { useId, type ReactNode } from "react";
import { useLinkComponent } from "../provider/ui-provider.js";
import { isNavActive } from "../shell/nav.js";

/** A coral mark on a section entry, e.g. a connection with failed deliveries. */
export interface SectionNavIndicator {
  tone: "fail";
  /** Joins the entry's accessible name: "GitLab, 1 failed delivery". */
  label: string;
}

export interface SectionNavItem {
  label: string;
  href: string;
  indicator?: SectionNavIndicator;
}

export interface SectionNavGroup {
  /** The group's visible heading, e.g. "Organization". */
  label: string;
  items: readonly SectionNavItem[];
}

export interface SectionNavProps {
  /** The nav's visible title; it also names the `nav` landmark. */
  title: string;
  /** Shown under the title, e.g. the organization's `OrgBadge`. */
  badge?: ReactNode;
  /** The current path; the entry `isNavActive` matches gets `aria-current="page"`. */
  currentPath: string;
  /** The groups in order; a group without items is left out. */
  groups: readonly SectionNavGroup[];
  /** Heading level of the title (group headings are one level below). Defaults to 2. */
  headingLevel?: 1 | 2 | 3;
  className?: string;
}

/** An entry's accessible name: its label, plus the indicator's label when it has one. */
export function sectionNavItemName(item: Pick<SectionNavItem, "label" | "indicator">): string {
  return item.indicator ? `${item.label}, ${item.indicator.label}` : item.label;
}

/**
 * A settings area's own navigation: a titled `nav` with one list per group under a visible
 * group heading. The active entry (same matching as the shell's `isNavActive`) gets
 * `aria-current="page"`; an indicator draws a coral dot and joins the entry's name.
 */
export function SectionNav({
  title,
  badge,
  currentPath,
  groups,
  headingLevel = 2,
  className,
}: SectionNavProps) {
  const Link = useLinkComponent();
  const id = useId();
  const Title = `h${headingLevel}` as const;
  const GroupHeading = `h${headingLevel + 1}` as "h2" | "h3" | "h4";
  const visible = groups.filter((group) => group.items.length > 0);
  return (
    <nav
      className={["or-subnav", className].filter(Boolean).join(" ")}
      aria-labelledby={`${id}-title`}
    >
      <div className="or-subnav__head">
        <Title id={`${id}-title`} className="or-subnav__title">
          {title}
        </Title>
        {badge !== undefined ? <div className="or-subnav__badge">{badge}</div> : null}
      </div>
      {visible.map((group, index) => {
        const headingId = `${id}-group-${index}`;
        return (
          <div key={`${index}-${group.label}`} className="or-subnav__group">
            <GroupHeading id={headingId} className="or-subnav__group-label">
              {group.label}
            </GroupHeading>
            <ul className="or-subnav__list" aria-labelledby={headingId}>
              {group.items.map((item) => (
                <li key={item.href} className="or-subnav__entry">
                  <Link
                    href={item.href}
                    className="or-subnav__item"
                    aria-label={item.indicator ? sectionNavItemName(item) : undefined}
                    aria-current={isNavActive(currentPath, item) ? "page" : undefined}
                  >
                    <span className="or-subnav__label">{item.label}</span>
                    {item.indicator ? (
                      <span
                        className={`or-dot or-dot--${item.indicator.tone} or-subnav__dot`}
                        aria-hidden="true"
                      />
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
