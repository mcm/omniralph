/**
 * An agent's machine settings (`<dataDir>/settings.json`): slots, pool limits,
 * accepted kinds, host tool paths, the installables allow-list and the version
 * pin. The agent is their only source: its page edits them, a hand edit applies
 * like a page save, and the heartbeat reports them. One schema validates the
 * file, the page's API bodies and the report. See
 * `docs/adr/0011-agent-local-settings.md`.
 */
import { TASK_TYPES, type TaskType } from "@omniralph/tasks";
import { z } from "zod";
import { AGENT_MIN_VERSION, agentVersionAtLeast } from "./agent-version.js";
import {
  AcceptedTaskTypes,
  AgentVersion,
  HostToolName,
  HostToolPath,
  LocalSlots as Slots,
  PackagePattern,
  defaultPoolLimit,
} from "./protocol.js";

/** An agent's slots when its settings don't set them. */
export const DEFAULT_MAX_CONCURRENCY = 5;

/** Installables an agent accepts when its settings don't say. */
export const DEFAULT_INSTALLABLE_ALLOW = ["@omniralph/*"] as const;

/** Whether one of the `allow` patterns matches the package name. */
export function installableAllowed(allow: readonly string[], packageName: string): boolean {
  return allow.some((pattern) => packagePatternRegExp(pattern).test(packageName));
}

function packagePatternRegExp(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`);
}

/** A version an agent may be pinned to: semver, at least `AGENT_MIN_VERSION`. */
export const AgentVersionPin = AgentVersion.refine(
  (version) => agentVersionAtLeast(version, AGENT_MIN_VERSION),
  { message: `must be ${AGENT_MIN_VERSION} or later` },
);

/** Per-pool caps (`short`, `long`), each 1–`maxConcurrency`; unset pools use `defaultPoolLimit`. */
export const LocalPoolLimits = z
  .object({ long: Slots.optional(), short: Slots.optional() })
  .strict();
export type LocalPoolLimits = z.infer<typeof LocalPoolLimits>;

/** The contents of `settings.json`. Unset keys take the defaults of `effectiveLocalSettings`. */
export const AgentLocalSettings = z
  .object({
    v: z.literal(1),
    /** How many attempts the agent runs at once, 1–32; default `DEFAULT_MAX_CONCURRENCY`. */
    maxConcurrency: Slots.optional(),
    poolLimits: LocalPoolLimits.optional(),
    /** The task types the agent runs (`system` jobs always run); absent means all. */
    acceptedTaskTypes: AcceptedTaskTypes.optional(),
    /** Host tool paths by name; a tool without one is looked up on `PATH`. */
    hostTools: z.record(HostToolName, HostToolPath).optional(),
    installables: z
      .object({
        /** Package patterns the agent may install; default `["@omniralph/*"]`, `[]` allows none. */
        allow: z.array(PackagePattern).max(100).optional(),
      })
      .strict()
      .optional(),
    update: z
      .object({
        /** A version that wins over the organization's policy; null or absent: none. */
        pin: AgentVersionPin.nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((settings, ctx) => {
    const maxConcurrency = settings.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    for (const pool of ["long", "short"] as const) {
      const limit = settings.poolLimits?.[pool];
      if (limit !== undefined && limit > maxConcurrency) {
        ctx.addIssue({
          code: "custom",
          path: ["poolLimits", pool],
          message: `must be at most maxConcurrency (${maxConcurrency})`,
        });
      }
    }
  });
export type AgentLocalSettings = z.infer<typeof AgentLocalSettings>;

/** The settings of an agent without a `settings.json`. */
export const EMPTY_LOCAL_SETTINGS: AgentLocalSettings = { v: 1 };

/** Every local setting with its default filled in. */
export interface EffectiveLocalSettings {
  maxConcurrency: number;
  poolLimits: { long: number; short: number };
  /** In `TASK_TYPES` order. */
  acceptedTaskTypes: TaskType[];
  hostTools: Record<string, string>;
  installablesAllow: string[];
  versionPin: string | null;
}

export function effectiveLocalSettings(settings: AgentLocalSettings): EffectiveLocalSettings {
  const maxConcurrency = settings.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const accepted = settings.acceptedTaskTypes;
  return {
    maxConcurrency,
    poolLimits: {
      long: settings.poolLimits?.long ?? defaultPoolLimit("long", maxConcurrency),
      short: settings.poolLimits?.short ?? defaultPoolLimit("short", maxConcurrency),
    },
    acceptedTaskTypes: accepted
      ? TASK_TYPES.filter((type) => accepted.includes(type))
      : [...TASK_TYPES],
    hostTools: { ...settings.hostTools },
    installablesAllow: [...(settings.installables?.allow ?? DEFAULT_INSTALLABLE_ALLOW)],
    versionPin: settings.update?.pin ?? null,
  };
}

/**
 * Which version of `settings.json` an edit was based on: the SHA-256 (hex) of
 * the file's bytes, or `"none"` when there is no file.
 */
export const LocalSettingsRevision = z.string().regex(/^(none|[0-9a-f]{64})$/);
export type LocalSettingsRevision = z.infer<typeof LocalSettingsRevision>;

/** The sections the agent's page saves on their own (`PUT /api/settings/{section}`). */
export const LOCAL_SETTINGS_SECTIONS = [
  "capacity",
  "kinds",
  "host-tools",
  "allow-list",
  "version",
] as const;
export type LocalSettingsSection = (typeof LOCAL_SETTINGS_SECTIONS)[number];

/** Slots and pool limits; null puts a value back to its default. */
export const CapacitySettingsBody = z
  .object({
    revision: LocalSettingsRevision,
    maxConcurrency: Slots.nullable(),
    poolLimits: z.object({ long: Slots.nullable(), short: Slots.nullable() }).strict(),
  })
  .strict();
export type CapacitySettingsBody = z.infer<typeof CapacitySettingsBody>;

export const KindsSettingsBody = z
  .object({ revision: LocalSettingsRevision, acceptedTaskTypes: AcceptedTaskTypes })
  .strict();
export type KindsSettingsBody = z.infer<typeof KindsSettingsBody>;

/** Every configured host tool path; a tool left out is looked up on `PATH`. */
export const HostToolsSettingsBody = z
  .object({
    revision: LocalSettingsRevision,
    hostTools: z.record(HostToolName, HostToolPath),
  })
  .strict();
export type HostToolsSettingsBody = z.infer<typeof HostToolsSettingsBody>;

/** The installables allow-list; `[]` allows none. */
export const AllowListSettingsBody = z
  .object({ revision: LocalSettingsRevision, allow: z.array(PackagePattern).max(100) })
  .strict();
export type AllowListSettingsBody = z.infer<typeof AllowListSettingsBody>;

export const VersionSettingsBody = z
  .object({ revision: LocalSettingsRevision, pin: AgentVersionPin.nullable() })
  .strict();
export type VersionSettingsBody = z.infer<typeof VersionSettingsBody>;

/** The body schema of each section. */
export const LOCAL_SETTINGS_SECTION_BODIES = {
  capacity: CapacitySettingsBody,
  kinds: KindsSettingsBody,
  "host-tools": HostToolsSettingsBody,
  "allow-list": AllowListSettingsBody,
  version: VersionSettingsBody,
} satisfies Record<LocalSettingsSection, z.ZodType>;

export interface LocalSettingsSectionBodies {
  capacity: CapacitySettingsBody;
  kinds: KindsSettingsBody;
  "host-tools": HostToolsSettingsBody;
  "allow-list": AllowListSettingsBody;
  version: VersionSettingsBody;
}

/**
 * The settings with one section replaced by `body` (its `revision` aside).
 * Not validated: parse the result with `AgentLocalSettings` (a pool limit may
 * now exceed the slots).
 */
export function applyLocalSettingsSection<S extends LocalSettingsSection>(
  settings: AgentLocalSettings,
  section: S,
  body: Omit<LocalSettingsSectionBodies[S], "revision">,
): AgentLocalSettings {
  const next: AgentLocalSettings = structuredClone(settings);
  // `S` doesn't narrow `body`; the section does.
  const value: unknown = body;
  switch (section) {
    case "capacity": {
      const { maxConcurrency, poolLimits } = value as Omit<CapacitySettingsBody, "revision">;
      if (maxConcurrency === null) delete next.maxConcurrency;
      else next.maxConcurrency = maxConcurrency;
      const limits: LocalPoolLimits = {};
      if (poolLimits.long !== null) limits.long = poolLimits.long;
      if (poolLimits.short !== null) limits.short = poolLimits.short;
      if (Object.keys(limits).length > 0) next.poolLimits = limits;
      else delete next.poolLimits;
      break;
    }
    case "kinds":
      next.acceptedTaskTypes = [
        ...(value as Omit<KindsSettingsBody, "revision">).acceptedTaskTypes,
      ];
      break;
    case "host-tools": {
      const { hostTools } = value as Omit<HostToolsSettingsBody, "revision">;
      if (Object.keys(hostTools).length > 0) next.hostTools = { ...hostTools };
      else delete next.hostTools;
      break;
    }
    case "allow-list":
      next.installables = {
        ...next.installables,
        allow: [...(value as Omit<AllowListSettingsBody, "revision">).allow],
      };
      break;
    case "version": {
      const { pin } = value as Omit<VersionSettingsBody, "revision">;
      if (pin === null) {
        if (next.update) delete next.update.pin;
        if (next.update && Object.keys(next.update).length === 0) delete next.update;
      } else {
        next.update = { ...next.update, pin };
      }
      break;
    }
  }
  return next;
}
