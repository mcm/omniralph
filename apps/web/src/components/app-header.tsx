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
  Button,
  cn,
  Avatar,
  AvatarFallback,
  AvatarImage,
  SidebarTrigger,
  useSidebar,
} from "@iamthemcmaster/ui";
import { IconChevronDown } from "@tabler/icons-react";
import { userDisplayName, userInitials } from "@/lib/user-display";
import { useCurrentUser } from "./current-user";
import { Link } from "./link";
import { UserMenu } from "./user-menu";

/** A breadcrumb; `href` only when the crumb has a page of its own. */
export interface Crumb {
  label: string;
  href?: string;
}

interface AppHeaderProps {
  /** Starts with the sidebar entry that is active for this page. */
  breadcrumbs?: Crumb[];
}

export function AppHeader({ breadcrumbs = [] }: AppHeaderProps) {
  const user = useCurrentUser();
  const { isMobile } = useSidebar();
  const name = userDisplayName(user);
  return (
    <header className="app-header">
      <div className="app-header-start">
        {/* Below 768px the sidebar is a sheet; this opens it. */}
        {isMobile && <SidebarTrigger className="shrink-0" />}
        {breadcrumbs.length > 0 && <HeaderBreadcrumbs crumbs={breadcrumbs} />}
      </div>

      <div className="app-header-end">
        {/* User menu, with the theme. Below 768px the name is hidden and the avatar alone opens it. */}
        <UserMenu
          trigger={
            <Button
              variant="ghost"
              size="sm"
              className="app-header-user"
              aria-label={`Account menu for ${name}`}
            >
              <Avatar className="app-header-avatar">
                {user.image && <AvatarImage src={user.image} alt="" />}
                <AvatarFallback>{userInitials(user)}</AvatarFallback>
              </Avatar>
              <span className="app-header-user-name">{name}</span>
              <IconChevronDown size={12} className="app-header-chevron" />
            </Button>
          }
        />
      </div>
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
