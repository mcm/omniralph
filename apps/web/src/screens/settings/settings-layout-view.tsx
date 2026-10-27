"use client";

import { OrgBadge, SectionNav, SplitView, useSplitWide } from "@omniralph/ui";
import { usePathname } from "next/navigation";
import { useRef, type ReactNode } from "react";
import { useCurrentUser } from "@/components/current-user";
import { useShowAdvanced } from "@/components/show-advanced";
import { useNavIndicators } from "../nav-indicators";
import { useConnections } from "./queries";
import { SETTINGS_PATH, SETTINGS_PATHS, settingsNavGroups } from "./settings-nav";
import "./settings.css";

/** The section nav's width: narrower than a list rail, it holds short labels. */
const NAV_WIDTH = { wide: 260, narrow: 240 };

/**
 * Settings (Design board Settings): the "Settings" title with the active organization's
 * badge and the section nav, beside the open page. With 880 px or more both show (on
 * `/settings`, General beside the nav); below that `/settings` is the section list and every
 * other page shows alone with "‹ Settings". A connection with failed deliveries not yet
 * replayed has a coral dot (the nav indicators, shared with the shell's Settings dot). The
 * connections are a live query and the
 * Advanced group follows the user's "Show advanced settings" at once; it only hides the
 * entries, the Advanced pages open by URL either way.
 */
export function SettingsLayoutView({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? SETTINGS_PATH;
  const { organization } = useCurrentUser();
  const [showAdvanced] = useShowAdvanced();
  const connections = useConnections().data?.connections ?? [];
  const failedDeliveries = useNavIndicators().data?.settings.byConnection;
  const splitRef = useRef<HTMLDivElement>(null);
  const wide = useSplitWide(splitRef);
  const index = pathname === SETTINGS_PATH;
  return (
    <SplitView
      ref={splitRef}
      className="or-settings"
      list={
        <SectionNav
          title="Settings"
          headingLevel={1}
          badge={<OrgBadge name={organization.name} />}
          // On the index, General shows beside the nav when both fit.
          currentPath={index && wide ? SETTINGS_PATHS.general : pathname}
          groups={settingsNavGroups({ connections, showAdvanced, failedDeliveries })}
        />
      }
      detail={index && !wide ? null : children}
      view={index ? "list" : "detail"}
      backLink={{ label: "Settings", href: SETTINGS_PATH }}
      listLabel="Settings sections"
      detailLabel="Setting"
      listWidth={NAV_WIDTH}
    />
  );
}
