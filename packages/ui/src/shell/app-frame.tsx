"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { IconMenu2, IconX } from "@tabler/icons-react";
import { useEffect, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { Tooltip } from "../actions/tooltip.js";
import { BrandLockup } from "../brand/wordmark.js";
import { useLinkComponent } from "../provider/ui-provider.js";
import { StatusDot } from "../status/status.js";
import { isNavActive, isNavAlert, menuButtonName, navAccessibleName, type NavItem } from "./nav.js";

/** The signed-in user, as the footer and the phone avatar show them. */
export interface FrameUser {
  name: string;
  /** Avatar image URL; `initials` show without one. */
  image?: string;
  initials: string;
}

export interface AppFrameProps {
  /** The current path (e.g. `usePathname()`), which decides the active entry. */
  currentPath: string;
  /** Where the glyph and wordmark link to. */
  brandHref: string;
  /** Every entry, in order; `placement` and `phone` decide where each one shows. */
  nav: readonly NavItem[];
  /** The organization picker, shown under the brand in the sidebar and the drawer. */
  orgPicker?: ReactNode;
  user: FrameUser;
  /**
   * Wraps a trigger in the user menu. It's called for the sidebar footer, the phone avatar
   * and the drawer footer; render a menu (e.g. `<Menu trigger={trigger} …/>`) around it.
   */
  userMenu: (trigger: ReactElement) => ReactNode;
  /** The page, rendered in the `main` landmark. */
  children?: ReactNode;
  /**
   * A panel beside the page (e.g. Ask), rendered as a grid column after `main` above 768 px:
   * 480 px wide from 1200 px, 360 px from 769 to 1199 px, hidden at phone widths. The page
   * narrows instead of being covered: no scrim, no focus trap. The node is its own landmark
   * (e.g. `<aside aria-label="Ask">`).
   */
  aside?: ReactNode;
  /**
   * Leaves the phone tab bar out (the board's `.no-tabbar`), for a page that opens full
   * screen on a phone (e.g. an Ask chat, with its composer pinned at the bottom). The tab
   * bar only shows at 768 px and narrower, so nothing changes on wider screens.
   */
  hideTabBar?: boolean;
}

type EntryVariant = "side" | "tab" | "drawer";

function Avatar({ user }: { user: FrameUser }) {
  return (
    <span className="or-avatar" aria-hidden="true">
      {user.image ? <img className="or-avatar__img" src={user.image} alt="" /> : user.initials}
    </span>
  );
}

function Indicator({ item }: { item: NavItem }) {
  const { indicator } = item;
  if (!indicator) return null;
  if (indicator.kind === "count") {
    const neutral = indicator.tone === "neutral";
    return (
      <span className={neutral ? "or-nav__n2" : "or-nav__count"} aria-hidden="true">
        {indicator.value}
      </span>
    );
  }
  return <StatusDot tone={indicator.tone} label={indicator.label} className="or-nav__pip" />;
}

function NavEntries({
  items,
  currentPath,
  variant,
  className,
}: {
  items: readonly NavItem[];
  currentPath: string;
  variant: EntryVariant;
  className?: string;
}) {
  const Link = useLinkComponent();
  if (items.length === 0) return null;
  return (
    <ul className={["or-nav__list", className].filter(Boolean).join(" ")}>
      {items.map((item) => {
        const Icon = item.icon;
        const active = isNavActive(currentPath, item);
        const { onSelect } = item;
        const link = (
          <Link
            href={item.href}
            className={`or-nav__item or-nav__item--${variant}`}
            aria-label={navAccessibleName(item)}
            aria-current={active ? "page" : undefined}
            aria-expanded={onSelect && variant === "side" ? item.expanded : undefined}
            data-nav-id={item.id}
            onClick={
              onSelect
                ? (event: MouseEvent<HTMLAnchorElement>) => {
                    if (!wantsSameTab(event) || !matchesMedia(NAV_SELECT_QUERY)) return;
                    event.preventDefault();
                    onSelect(event);
                  }
                : undefined
            }
          >
            <span className="or-nav__icon">
              <Icon size={variant === "tab" ? 22 : 18} stroke={1.75} aria-hidden="true" />
            </span>
            <span className="or-nav__label or-rail-hidden">{item.label}</span>
            <Indicator item={item} />
          </Link>
        );
        return (
          <li key={item.id} className="or-nav__entry">
            {variant === "side" ? (
              // Shown only on the icon rail, where the label is visually hidden.
              <Tooltip content={item.label} side="right" className="or-tip--rail">
                {link}
              </Tooltip>
            ) : (
              link
            )}
          </li>
        );
      })}
    </ul>
  );
}

function UserFooter({ user, userMenu }: Pick<AppFrameProps, "user" | "userMenu">) {
  return (
    <div className="or-user-footer">
      {userMenu(
        <button type="button" className="or-user">
          <Avatar user={user} />
          <span className="or-user__name or-rail-hidden">{user.name}</span>
        </button>,
      )}
    </div>
  );
}

/** Wider than this, the drawer's hamburger is gone, so an open drawer closes. */
export const DRAWER_CLOSE_QUERY = "(min-width: 769px)";

/** While this matches, a click on an entry with `onSelect` calls it instead of navigating. */
export const NAV_SELECT_QUERY = "(min-width: 769px)";

function matchesMedia(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query).matches
    : false;
}

function wantsSameTab(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * The app's layout: a 232 px sidebar from 1200 px, a 64 px icon rail from 769 to 1199 px,
 * and a top bar, a bottom tab bar and a drawer at 768 px and narrower (all by CSS). It
 * knows nothing about routes or sessions: entries, the picker and the user come in as props.
 */
export function AppFrame({
  currentPath,
  brandHref,
  nav,
  orgPicker,
  user,
  userMenu,
  children,
  aside,
  hideTabBar = false,
}: AppFrameProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Any navigation closes the drawer, including ones its link click didn't make (a route
  // change after a confirm dialog, the browser's back button).
  const [drawerPath, setDrawerPath] = useState(currentPath);
  if (drawerPath !== currentPath) {
    setDrawerPath(currentPath);
    setDrawerOpen(false);
  }
  useEffect(() => {
    if (!drawerOpen || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(DRAWER_CLOSE_QUERY);
    const close = () => {
      if (query.matches) setDrawerOpen(false);
    };
    close();
    query.addEventListener("change", close);
    return () => query.removeEventListener("change", close);
  }, [drawerOpen]);

  const mainEntries = nav.filter((item) => item.placement === "main");
  const bottomEntries = nav.filter((item) => item.placement === "bottom");
  const tabs = hideTabBar ? [] : nav.filter((item) => item.phone === "tab");
  const drawerEntries = nav.filter((item) => item.phone === "drawer");
  const alerts = drawerEntries.filter((item) => isNavAlert(item.indicator)).length;

  function closeOnLink(event: MouseEvent<HTMLDivElement>) {
    // Router links (e.g. Next's) prevent the default, so `defaultPrevented` isn't checked;
    // modified clicks open a new tab and leave the drawer open.
    if (!wantsSameTab(event)) return;
    if (event.target instanceof Element && event.target.closest("a[href]")) {
      setDrawerOpen(false);
    }
  }

  return (
    <div
      className={[
        "or-root or-frame",
        tabs.length > 0 ? "or-frame--tabs" : null,
        hideTabBar ? "or-frame--no-tabbar" : null,
        aside != null ? "or-frame--aside" : null,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
        <header className="or-topbar">
          <Dialog.Trigger asChild>
            <button
              type="button"
              className="or-icon-btn or-icon-btn--ghost or-icon-btn--md or-topbar__menu"
              aria-label={menuButtonName(alerts)}
            >
              <IconMenu2 size={20} stroke={1.75} aria-hidden="true" />
              {alerts > 0 ? <span className="or-topbar__alert" aria-hidden="true" /> : null}
            </button>
          </Dialog.Trigger>
          <BrandLockup href={brandHref} className="or-topbar__brand" />
          {userMenu(
            <button type="button" className="or-topbar__avatar" aria-label={user.name}>
              <Avatar user={user} />
            </button>,
          )}
        </header>

        <nav className="or-sidebar" aria-label="Primary">
          <div className="or-sidebar__brand">
            <BrandLockup href={brandHref} />
          </div>
          {orgPicker ? <div className="or-sidebar__org">{orgPicker}</div> : null}
          <NavEntries items={mainEntries} currentPath={currentPath} variant="side" />
          <div className="or-sidebar__gap" />
          <NavEntries items={bottomEntries} currentPath={currentPath} variant="side" />
          <UserFooter user={user} userMenu={userMenu} />
        </nav>

        <main className="or-frame__main">{children}</main>

        {aside != null ? <div className="or-frame__aside">{aside}</div> : null}

        {tabs.length > 0 ? (
          <nav className="or-tabbar" aria-label="Primary">
            <NavEntries items={tabs} currentPath={currentPath} variant="tab" />
          </nav>
        ) : null}

        <Dialog.Portal>
          <Dialog.Overlay className="or-drawer__scrim" />
          <Dialog.Content
            className="or-root or-drawer"
            aria-describedby={undefined}
            onClick={closeOnLink}
          >
            <Dialog.Title className="or-sr-only">Menu</Dialog.Title>
            <div className="or-drawer__head">
              <BrandLockup href={brandHref} />
              {/* No tooltip: Radix focuses this button on open, and Escape should close the drawer. */}
              <Dialog.Close
                className="or-icon-btn or-icon-btn--ghost or-icon-btn--md"
                aria-label="Close menu"
              >
                <IconX size={18} stroke={1.75} aria-hidden="true" />
              </Dialog.Close>
            </div>
            {orgPicker ? <div className="or-drawer__org">{orgPicker}</div> : null}
            <NavEntries
              items={drawerEntries}
              currentPath={currentPath}
              variant="drawer"
              className="or-drawer__nav"
            />
            <div className="or-sidebar__gap" />
            <UserFooter user={user} userMenu={userMenu} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
