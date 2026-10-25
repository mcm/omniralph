"use client";

import * as React from "react";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  cn,
} from "@iamthemcmaster/ui";
import { Link } from "./link";

/** A breadcrumb; `href` only when the crumb has a page of its own. */
export interface Crumb {
  label: string;
  href?: string;
}

interface AppHeaderProps {
  /** Starts with the section the page belongs to. */
  breadcrumbs?: Crumb[];
}

/**
 * Today's page header inside the 2.0 shell: the page's breadcrumbs. The theme and "Sign out"
 * live in the shell's user menu, and the shell draws the navigation at every width.
 */
export function AppHeader({ breadcrumbs = [] }: AppHeaderProps) {
  return (
    <header className="app-header">
      {breadcrumbs.length > 0 && <HeaderBreadcrumbs crumbs={breadcrumbs} />}
    </header>
  );
}

/**
 * One line of crumbs that never wraps: every label truncates, and below 768px the middle
 * crumbs collapse into an ellipsis (globals.css). Parents without a page are plain text.
 */
function HeaderBreadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  const last = crumbs.length - 1;
  // Only a current page longer than the width it is guaranteed on phone (9ch) reserves
  // it; a short one ("Rules") takes its own width and leaves the rest to its parents.
  const longCurrent = (crumbs[last]?.label.length ?? 0) > 9;
  return (
    <Breadcrumb className="app-crumbs">
      <BreadcrumbList className="app-crumbs-list">
        {crumbs.map((crumb, i) => {
          const middle = i > 0 && i < last;
          return (
            <React.Fragment key={i}>
              {i === 1 && last > 1 && (
                <>
                  <BreadcrumbItem className="app-crumb-ellipsis">
                    <BreadcrumbEllipsis className="app-crumb-ellipsis-icon" />
                  </BreadcrumbItem>
                  <BreadcrumbSeparator className="app-crumb-ellipsis" />
                </>
              )}
              <BreadcrumbItem
                className={cn(
                  "app-crumb",
                  middle && "app-crumb-middle",
                  i === last && longCurrent && "app-crumb-long",
                )}
              >
                {i === last ? (
                  <BreadcrumbPage className="app-crumb-label">{crumb.label}</BreadcrumbPage>
                ) : crumb.href ? (
                  <BreadcrumbLink asChild className="app-crumb-label">
                    <Link href={crumb.href}>{crumb.label}</Link>
                  </BreadcrumbLink>
                ) : (
                  <span className="app-crumb-label">{crumb.label}</span>
                )}
              </BreadcrumbItem>
              {i < last && (
                <BreadcrumbSeparator className={middle ? "app-crumb-middle" : undefined} />
              )}
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
