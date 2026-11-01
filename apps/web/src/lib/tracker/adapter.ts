/**
 * What the web app needs from each tracker beyond its `TrackerGateway`: how
 * to reach the organization's connected one, its provider-only reads, and its
 * webhook deliveries. Each provider implements it under `lib/tracker/<provider>/`;
 * `adapters.ts` is the registry neutral code finds them through.
 */
import type { Database } from "@omniralph/db";
import type {
  CreateIssueInput,
  IssueSummary,
  IssueWithRouting,
  ListIssuesFilter,
  RoutingIssue,
  TrackerCapability,
  TrackerEvent,
  TrackerGateway,
  TrackerProvider,
} from "@omniralph/tracker";
import type { HandledTrackerEvent, TrackerEventContext } from "./events";
import type { IssuePlacement } from "./placement";
import type { TrackerSettingsOptions } from "./settings-values";

export interface TrackerConnectionOptions {
  db: Database;
  /** The organization whose connected tracker to use. */
  organizationId: string;
  /**
   * Read the provider's fixture workspace instead when its fixture mode is on
   * (e2e and local runs, e.g. `OMNIRALPH_FIXTURE_LINEAR=1`).
   */
  fixtures?: boolean;
  /**
   * Longest wait for a credential refresh while the current credentials are
   * still valid (past it they are used as they are). Unset waits.
   */
  refreshTimeoutMs?: number;
}

/**
 * A tracker's reads that only some trackers have, behind neutral shapes:
 * routing fields in one query, placement extras (Linear's milestone and
 * cycle) and the extra settings lists.
 */
export interface TrackerExtras {
  /** The issue's routing fields and its parent's, in one read. */
  routingIssue(idOrIdentifier: string): Promise<RoutingIssue>;
  /** The issue's placement, with the provider's `extras`. */
  issuePlacement(issueId: string): Promise<IssuePlacement>;
  /** Creates an issue with placement `extras`; returns the extras that stuck. */
  createIssueWithExtras(
    input: CreateIssueInput,
    extras: Record<string, string>,
  ): Promise<{ issue: IssueSummary; extras: Record<string, string> }>;
  /** `listIssues` with each issue's routing fields read in the same query. */
  listIssuesWithRouting(
    filter: ListIssuesFilter,
  ): Promise<{ issues: IssueWithRouting[]; endCursor: string | null }>;
  /** The settings lists beyond teams, labels, projects and states. */
  settingsOptions(): Promise<
    Pick<TrackerSettingsOptions, "projectMilestones" | "cycles" | "users">
  >;
}

/** What replaying a stored delivery runs, as a live one would. */
export interface TrackerReplayHandlers {
  db: Database;
  acknowledge: (event: HandledTrackerEvent, context: TrackerEventContext) => Promise<void>;
  handle: (event: HandledTrackerEvent, context: TrackerEventContext) => Promise<void>;
}

export interface TrackerReplayInput {
  integration: { id: string; organizationId: string; externalId: string };
  payload: Record<string, unknown>;
  event: TrackerEvent;
  deliveryId: string | null;
  replayOfId: string;
  replayedBy: string;
}

export interface TrackerWebAdapter {
  readonly provider: TrackerProvider;
  /** The provider's name as people read it ("Linear"). */
  readonly name: string;
  /** The repository file a project's conventions for its issues go in, which triage reads (`LINEAR.md`). */
  readonly conventionsFile: string;
  /** The optional capabilities its gateways have, known without connecting (e.g. to offer tools). */
  readonly capabilities: readonly TrackerCapability[];
  /**
   * The URL of another issue of the same workspace, derived from one issue's URL (no read);
   * null when it can't be derived.
   */
  siblingIssueUrl(issueUrl: string, identifier: string): string | null;
  /** The connected tracker's gateway; throws `TrackerNotConnectedError` without one. */
  getGateway(options: TrackerConnectionOptions): Promise<TrackerGateway>;
  /** A gateway whose every call fails with `TrackerNotConnectedError`. */
  disconnectedGateway(): TrackerGateway;
  /** A gateway that runs `load` on its first call (again after a failed one). */
  lazyGateway(load: () => Promise<TrackerGateway>): TrackerGateway;
  /** The provider-only reads of a gateway, or null when it has none (e.g. a test fake). */
  extras(gateway: TrackerGateway): TrackerExtras | null;
  /** Revokes stored credentials on disconnect (best effort; throws on failure). */
  revokeCredentials(credentials: unknown): Promise<void>;
  /** A stored delivery's payload as a tracker event. */
  parseDelivery(payload: Record<string, unknown>): TrackerEvent;
  /** Replays a stored delivery through the live delivery processing; the replay's log ID. */
  replayDelivery(
    handlers: TrackerReplayHandlers,
    input: TrackerReplayInput,
  ): Promise<string | null>;
}
