/** The harness page's tabs, in order (shared by the server page and the client tab strip). */
export const HARNESS_TABS = [
  { value: "overview", label: "Overview" },
  { value: "settings", label: "Settings" },
  { value: "installables", label: "Installables" },
  { value: "host-tools", label: "Host tools" },
] as const;

/** A harness page, as its tab and route segment (Overview is the harness's own URL). */
export type HarnessTab = (typeof HARNESS_TABS)[number]["value"];

export const HARNESS_TAB_LABELS = Object.fromEntries(
  HARNESS_TABS.map((tab) => [tab.value, tab.label]),
) as Record<HarnessTab, string>;

/** The URL of a harness's tab. */
export function harnessTabHref(agentId: string, tab: HarnessTab): string {
  return tab === "overview" ? `/harnesses/${agentId}` : `/harnesses/${agentId}/${tab}`;
}
