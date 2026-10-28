/**
 * The agent page's layout (Design Considerations › Layout): a top bar with the brand (home),
 * the agent's name and the control panel's host, then the section nav ("Agent") beside the
 * open page, as Settings does. With 880 px or more both show (on `/`, Overview beside the
 * nav); below that `/` is the section list and every other page shows alone with "‹ Agent".
 */
import {
  BrandLockup,
  MetaBadge,
  SectionNav,
  SplitView,
  ThemeControl,
  useSplitWide,
} from "@omniralph/ui";
import { useRef } from "react";
import { LiveNoticeSlot } from "./live/live-provider.js";
import { AGENT_SECTIONS, INDEX_PATH, agentNavGroups } from "./nav.js";
import { routeFor } from "./pages/routes.js";
import { usePath } from "./router.js";
import { useAgentState } from "./state.js";

/** The section nav's width: narrower than a list rail, it holds short labels. */
const NAV_WIDTH = { wide: 260, narrow: 240 };

/** The control panel's host (`omniralph.example.com`), or the URL as given. */
export function serverHost(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

export function AgentShell() {
  const path = usePath();
  const state = useAgentState().data;
  const splitRef = useRef<HTMLDivElement>(null);
  const wide = useSplitWide(splitRef);
  const index = path === INDEX_PATH;
  const route = routeFor(path);
  // On `/` at narrow widths nothing is open yet: no entry is the current one.
  const currentPath =
    route.section && !(index && !wide) ? AGENT_SECTIONS[route.section].href : path;
  return (
    <div className="agent-page">
      <header className="agent-topbar">
        <BrandLockup href={INDEX_PATH} className="agent-topbar__brand" />
        {state ? (
          <div className="agent-topbar__facts">
            <MetaBadge text={state.agent.name} mono />
            <MetaBadge text={serverHost(state.agent.server)} />
          </div>
        ) : null}
      </header>
      <LiveNoticeSlot />
      <SplitView
        ref={splitRef}
        className="agent-split"
        list={
          <div className="agent-nav">
            <SectionNav
              title="Agent"
              headingLevel={1}
              currentPath={currentPath}
              groups={agentNavGroups(state?.problems ?? [])}
            />
            <ThemeControl className="agent-nav__theme" />
          </div>
        }
        detail={index && !wide ? null : <div className="agent-detail">{route.page}</div>}
        view={index ? "list" : "detail"}
        backLink={route.backLink}
        listLabel="Agent sections"
        detailLabel={route.section ? AGENT_SECTIONS[route.section].label : "Page"}
        listWidth={NAV_WIDTH}
      />
    </div>
  );
}
