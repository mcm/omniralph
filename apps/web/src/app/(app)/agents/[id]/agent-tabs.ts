/** The agent page's tabs, in order (shared by the server page and the client tab strip). */
export const AGENT_TABS = [
  { value: "overview", label: "Overview" },
  { value: "settings", label: "Settings" },
  { value: "installables", label: "Installables" },
  { value: "host-tools", label: "Host tools" },
] as const;

/** An agent page, as its tab and route segment (Overview is the agent's own URL). */
export type AgentTab = (typeof AGENT_TABS)[number]["value"];

export const AGENT_TAB_LABELS = Object.fromEntries(
  AGENT_TABS.map((tab) => [tab.value, tab.label]),
) as Record<AgentTab, string>;

/** The URL of an agent's tab. */
export function agentTabHref(agentId: string, tab: AgentTab): string {
  return tab === "overview" ? `/agents/${agentId}` : `/agents/${agentId}/${tab}`;
}
