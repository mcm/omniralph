/**
 * The connected tracker's values the settings pages pick from. Lists a tracker
 * doesn't have (milestones, cycles, users on some) are empty.
 */
export interface TrackerSettingsOptions {
  teams: Array<{ key: string; name: string }>;
  /** Label names, workspace and team labels de-duplicated (ignoring case). */
  labels: string[];
  /** Project names. */
  projects: string[];
  /** Workflow state names, de-duplicated across teams (ignoring case). */
  states: string[];
  /** Project milestone names, de-duplicated across projects (ignoring case). */
  projectMilestones: string[];
  /** Current and upcoming cycles, by team key then number. */
  cycles: Array<{ id: string; number: number; name: string | null; teamKey: string }>;
  /** Active users, by name. */
  users: Array<{ id: string; name: string }>;
}
