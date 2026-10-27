/**
 * The live change-event catalogue: what the control panel publishes on Ably after a
 * committed write that changes what a screen shows, and what the client live data layer
 * subscribes to and maps to the queries it invalidates. Events carry IDs only, never
 * content (no titles, bodies, payloads or names): a client refetches through the normal,
 * authorized endpoints, so a token that outlives a membership leaks nothing but IDs.
 *
 * Changes everyone in an organization can see go on `orgChangesChannel(organizationId)`;
 * per-user state (the Inbox's Done, Skip and Snooze) on `userChangesChannel(userId)`.
 * Every message is named `CHANGE_EVENT_NAME` and its data is one `ChangeEvent`.
 *
 * Safe to import in the browser (no server code).
 */
import type { ChangeResource } from "@omniralph/db/changes";
import { z } from "zod";

/** The version of the event shape (`v`). */
export const CHANGE_EVENT_VERSION = 1;

/** The Ably message name of every change event. */
export const CHANGE_EVENT_NAME = "change";

/** What changed. */
export const CHANGE_RESOURCES = [
  "run",
  "transcript",
  "pull_request",
  "inbox_state",
  "webhook_event",
  "settings",
  "agent",
  "repository",
  "connection",
  "organization",
  "work_item",
] as const satisfies readonly ChangeResource[];
export type ChangeEventResource = (typeof CHANGE_RESOURCES)[number];

/** The tracked settings sections a `settings` event names. */
export const SETTINGS_SECTIONS = [
  "repository.reviews",
  "repository.coding",
  "repository.agents",
  "repository.ask",
  "repository.playbooks",
  "routing_rules",
  "connection",
  "organization",
  "agent_defaults",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/**
 * Organization settings sections a `settings` event names that keep no change history (not
 * part of `SETTINGS_SECTIONS` or the settings history API): the organization's playbooks
 * (`subjectId` = the playbook) and the playbooks chat runs, organization-wide (`ids` = the
 * organization) or for a connection's channel (`subjectId` = the chat connection).
 */
export const UNTRACKED_SETTINGS_SECTIONS = ["playbooks", "chat_playbooks"] as const;
export type UntrackedSettingsSection = (typeof UNTRACKED_SETTINGS_SECTIONS)[number];

/**
 * Sections of the user's own record a `settings` event names, only on the user's own
 * channel and not part of the settings history: `profile` (their theme and
 * whether they show advanced settings) and `linked_accounts` (their chat accounts linked
 * or unlinked, in the event's organization).
 */
export const USER_SETTINGS_SECTIONS = ["profile", "linked_accounts"] as const;
export type UserSettingsSection = (typeof USER_SETTINGS_SECTIONS)[number];

const id = z.guid();

/** A work item's URL ID: its tracker and its ID there (`linear-<issue id>`). */
export const WORK_ITEM_ID_PATTERN = /^linear-[0-9A-Za-z-]{1,100}$/;

/** Fields every event has; `ids` are the changed rows' IDs. */
const base = {
  v: z.literal(CHANGE_EVENT_VERSION),
  ids: z.array(id).min(1),
  organizationId: id,
  /** When the change was committed (ISO 8601). */
  at: z.iso.datetime(),
};

/**
 * One schema per resource; each is strict, so an event can't carry anything but IDs.
 *
 * - `run`: a run changed (`ids` = run IDs, `runId` = the run), or one of its attempts
 *   did (`ids` = job IDs, `runId` = their run; absent for system work such as a repo sync).
 * - `transcript`: an attempt's transcript grew (`ids` = job IDs), coalesced to at most
 *   one leading and one trailing event per run per second.
 * - `pull_request`: a run's pull or merge request changed state (`ids` = lane IDs).
 * - `inbox_state`: the user marked Inbox items Done, Skipped, Snoozed or Restored
 *   (`ids` = item keys); only on the user's own channel.
 * - `webhook_event`: a delivery was recorded or replayed (`ids` = webhook event IDs).
 * - `settings`: a settings `section` was saved, for `subjectId` (e.g. the repository) when
 *   the section has one (`ids` = the subject, else the organization). A playbook's save or
 *   delete is section `playbooks` with the playbook as its subject; a save of the playbooks
 *   chat runs is section `chat_playbooks` (a channel override's: its connection the subject).
 *   Section `profile` is the user's own record and `linked_accounts` their linked chat
 *   accounts (`ids` = the user), on the user's channel.
 * - `agent`: an agent enrolled, was revoked or deleted, went online or offline, or its
 *   settings, pins, update state or installs changed (`ids` = agent IDs).
 * - `repository`: repositories were connected, disconnected or switched (`ids` = repo IDs).
 * - `connection`: a code host, tracker or chat connection changed (`ids` = connection IDs).
 * - `organization`: the organization, its members, invitations or domains changed; on the
 *   user's own channel, their membership of it did (their organizations changed).
 * - `work_item`: work items of a tracker changed there or in Omniralph (an action, a run or
 *   triage of them, a repo choice), so the Backlog, its counts, Up next and their details may
 *   have (`ids` = work item URL IDs, `linear-<issue id>`).
 */
export const changeEventSchemas = {
  run: z.strictObject({ ...base, resource: z.literal("run"), runId: id.optional() }),
  transcript: z.strictObject({
    ...base,
    resource: z.literal("transcript"),
    runId: id.optional(),
  }),
  pull_request: z.strictObject({
    ...base,
    resource: z.literal("pull_request"),
    runId: id.optional(),
  }),
  inbox_state: z.strictObject({
    ...base,
    resource: z.literal("inbox_state"),
    // Item keys (`manual_story:<id>`, `failed:<runId>:<attemptId>`, ...): IDs and kinds only.
    ids: z.array(z.string().regex(/^[a-z_]+(:[0-9A-Za-z_.:,+-]+)+$/)).min(1),
  }),
  webhook_event: z.strictObject({
    ...base,
    resource: z.literal("webhook_event"),
    runId: id.optional(),
  }),
  settings: z.strictObject({
    ...base,
    resource: z.literal("settings"),
    section: z.enum([
      ...SETTINGS_SECTIONS,
      ...UNTRACKED_SETTINGS_SECTIONS,
      ...USER_SETTINGS_SECTIONS,
    ]),
    subjectId: id.optional(),
  }),
  agent: z.strictObject({ ...base, resource: z.literal("agent") }),
  repository: z.strictObject({ ...base, resource: z.literal("repository") }),
  connection: z.strictObject({ ...base, resource: z.literal("connection") }),
  organization: z.strictObject({ ...base, resource: z.literal("organization") }),
  work_item: z.strictObject({
    ...base,
    resource: z.literal("work_item"),
    // Work item URL IDs: the tracker and its ID there, never text.
    ids: z.array(z.string().regex(WORK_ITEM_ID_PATTERN)).min(1),
  }),
} satisfies { [R in ChangeEventResource]: z.ZodType<{ resource: R }> };

export const changeEventSchema = z.discriminatedUnion("resource", [
  changeEventSchemas.run,
  changeEventSchemas.transcript,
  changeEventSchemas.pull_request,
  changeEventSchemas.inbox_state,
  changeEventSchemas.webhook_event,
  changeEventSchemas.settings,
  changeEventSchemas.agent,
  changeEventSchemas.repository,
  changeEventSchemas.connection,
  changeEventSchemas.organization,
  changeEventSchemas.work_item,
]);

export type ChangeEvent = z.infer<typeof changeEventSchema>;
export type ChangeEventOf<R extends ChangeEventResource> = Extract<ChangeEvent, { resource: R }>;

/** Parses a received message's data; null when it isn't a known change event. */
export function parseChangeEvent(data: unknown): ChangeEvent | null {
  const parsed = changeEventSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** The organization's change channel (never an agent's wake channel `org:<id>`). */
export function orgChangesChannel(organizationId: string): string {
  return `org:${organizationId}:changes`;
}

/** The user's own change channel, for per-user state. */
export function userChangesChannel(userId: string): string {
  return `user:${userId}:changes`;
}
