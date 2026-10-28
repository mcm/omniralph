import { z } from "zod";
import { organizationRefSchema, runRowSchema, scmProviderSchema } from "./runs";
import { workItemRowSchema } from "./work-items";

/** Wire formats of search and jump (`/api/ui/search`). */

/** Shorter queries list the user's recent items instead of searching. */
export const SEARCH_MIN_QUERY_LENGTH = 2;
/** Recent items shown for an empty or short query. */
export const SEARCH_RECENT_LIMIT = 5;
/** Default and largest number of results per kind. */
export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 20;
/** Longest query searched. */
export const SEARCH_MAX_QUERY_LENGTH = 200;

/** What search finds, in the order its groups show when they match equally well. */
export const SEARCH_KINDS = ["run", "workItem", "repository", "agent", "settings"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/** Each kind's group heading. */
export const SEARCH_GROUP_LABELS: Readonly<Record<SearchKind | "recent", string>> = {
  recent: "Recent",
  run: "Runs",
  workItem: "Work items",
  repository: "Repos",
  agent: "Agents",
  settings: "Settings",
};

const organization = z
  .union([z.literal("all"), z.uuid()], { error: "Unknown organization." })
  .optional();

/**
 * `GET /api/ui/search?q=&limit=&organization=`: `q` (trimmed; shorter than
 * `SEARCH_MIN_QUERY_LENGTH`: the recent items), `limit` results per kind, and the
 * organization scope (`all`, or one of the user's organizations; default the active one).
 */
export const searchQuerySchema = z.object({
  q: z
    .string()
    .max(SEARCH_MAX_QUERY_LENGTH, { error: "The search is too long." })
    .default("")
    .transform((value) => value.trim()),
  limit: z.coerce
    .number({ error: "The limit must be a number." })
    .int({ error: "The limit must be a whole number." })
    .min(1, { error: "The limit must be at least 1." })
    .max(SEARCH_MAX_LIMIT, { error: `The limit must be at most ${SEARCH_MAX_LIMIT}.` })
    .default(SEARCH_DEFAULT_LIMIT),
  organization,
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/** A repo result: its organization, code host, full path and name (the path's last segment). */
export const searchRepositorySchema = z.object({
  id: z.string(),
  organization: organizationRefSchema,
  provider: scmProviderSchema,
  fullPath: z.string(),
});

/** An agent result: its organization, name and whether it is connected. */
export const searchAgentSchema = z.object({
  id: z.string(),
  organization: organizationRefSchema,
  name: z.string(),
  /** "Online", "Offline 3d", "Never connected", "Revoked". */
  status: z.object({ label: z.string(), tone: z.enum(["good", "fail", "neutral"]) }),
});

/** A settings page result: its title and its section in the Settings nav. */
export const searchSettingsPageSchema = z.object({
  title: z.string(),
  section: z.string(),
});

/** One result: what it is, its ID, where it opens, and what its row shows. */
export const searchResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), id: z.string(), href: z.string(), run: runRowSchema }),
  z.object({
    kind: z.literal("workItem"),
    id: z.string(),
    href: z.string(),
    workItem: workItemRowSchema,
  }),
  z.object({
    kind: z.literal("repository"),
    id: z.string(),
    href: z.string(),
    repository: searchRepositorySchema,
  }),
  z.object({
    kind: z.literal("agent"),
    id: z.string(),
    href: z.string(),
    agent: searchAgentSchema,
  }),
  z.object({
    kind: z.literal("settings"),
    id: z.string(),
    href: z.string(),
    settings: searchSettingsPageSchema,
  }),
]);
export type SearchResult = z.infer<typeof searchResultSchema>;

/** A group of results: one kind's matches, or the recent items. */
export const searchGroupSchema = z.object({
  id: z.enum(["recent", ...SEARCH_KINDS]),
  label: z.string(),
  results: z.array(searchResultSchema),
});
export type SearchGroup = z.infer<typeof searchGroupSchema>;

/**
 * The search's answer: `recent` (a short query: one "Recent" group of the user's most
 * recently opened items, possibly empty) or `results` (the kinds with matches, the best
 * matching group first; within a group, exact matches, then prefix, then substring, each
 * most recently updated first).
 */
export const searchResponseSchema = z.object({
  mode: z.enum(["recent", "results"]),
  groups: z.array(searchGroupSchema),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

/** `POST /api/ui/search/recent`: the user opened this result. */
export const recordRecentBodySchema = z.object({
  kind: z.enum(SEARCH_KINDS, { error: "Unknown kind." }),
  id: z.string().min(1).max(300),
});
export type RecordRecentBody = z.infer<typeof recordRecentBodySchema>;
