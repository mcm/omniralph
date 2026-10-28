/**
 * The Capacity card's draft, validation and save bar items. Slots and pool limits are text
 * (blank: the default); a pool's default follows the draft's slots. Pure, so the card and its
 * tests word every change the same way.
 */
import type { StagedChange } from "@omniralph/ui";
import {
  DEFAULT_MAX_CONCURRENCY,
  MAX_MAX_CONCURRENCY,
  MIN_MAX_CONCURRENCY,
  defaultPoolLimit,
  type AgentLocalSettings,
  type CapacitySettingsBody,
  type KindsSettingsBody,
} from "@omniralph/shared";
import { TASK_TYPES, type TaskType } from "@omniralph/tasks";

export interface CapacityDraft {
  /** Slots (`maxConcurrency`); blank: the default. */
  slots: string;
  /** Coding slots (the `long` pool); blank: the default. */
  coding: string;
  /** Review and ask slots (the `short` pool); blank: the default. */
  short: string;
  /** The accepted kinds, in `TASK_TYPES` order; never empty. */
  kinds: TaskType[];
}

export type CapacityField = keyof CapacityDraft;

/** The kinds in the order the card lists them, with their labels. */
export const KIND_OPTIONS: readonly { kind: TaskType; label: string }[] = [
  { kind: "review", label: "Review" },
  { kind: "coding", label: "Coding" },
  { kind: "query", label: "Ask" },
];

export const KEEP_ONE_KIND = "Keep at least one kind";
export const POOL_ABOVE_SLOTS = "Can't be more than Slots";
export const SLOTS_OUT_OF_RANGE = `Enter a number from ${MIN_MAX_CONCURRENCY} to ${MAX_MAX_CONCURRENCY}`;
export const POOL_OUT_OF_RANGE = "Enter a number from 1 to Slots";

export function capacityDraft(settings: AgentLocalSettings): CapacityDraft {
  const accepted = settings.acceptedTaskTypes;
  return {
    slots: settings.maxConcurrency?.toString() ?? "",
    coding: settings.poolLimits?.long?.toString() ?? "",
    short: settings.poolLimits?.short?.toString() ?? "",
    kinds: accepted ? TASK_TYPES.filter((kind) => accepted.includes(kind)) : [...TASK_TYPES],
  };
}

/** A whole number, null for blank, NaN for anything else. */
function parseCount(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function validSlots(value: number | null): value is number {
  return (
    value !== null &&
    Number.isInteger(value) &&
    value >= MIN_MAX_CONCURRENCY &&
    value <= MAX_MAX_CONCURRENCY
  );
}

/** The slots the draft runs on (the default while the field is blank or invalid). */
export function draftSlots(draft: CapacityDraft): number {
  const value = parseCount(draft.slots);
  return validSlots(value) ? value : DEFAULT_MAX_CONCURRENCY;
}

type Pool = "long" | "short";
const POOL_FIELD: Record<Pool, "coding" | "short"> = { long: "coding", short: "short" };

/** A pool's limit in the draft: its value, or its default for the draft's slots. */
export function draftPoolLimit(draft: CapacityDraft, pool: Pool): number {
  const value = parseCount(draft[POOL_FIELD[pool]]);
  return value === null || Number.isNaN(value) ? defaultPoolLimit(pool, draftSlots(draft)) : value;
}

/** The placeholder of a blank field: its default ("Default: 4"). */
export function placeholderFor(draft: CapacityDraft, field: "slots" | "coding" | "short"): string {
  if (field === "slots") return `Default: ${DEFAULT_MAX_CONCURRENCY}`;
  return `Default: ${defaultPoolLimit(field === "coding" ? "long" : "short", draftSlots(draft))}`;
}

/** What's wrong with the draft, by field (none: it can be saved). */
export function capacityErrors(draft: CapacityDraft): Partial<Record<CapacityField, string>> {
  const errors: Partial<Record<CapacityField, string>> = {};
  const slots = parseCount(draft.slots);
  if (slots !== null && !validSlots(slots)) errors.slots = SLOTS_OUT_OF_RANGE;
  const max = draftSlots(draft);
  for (const field of ["coding", "short"] as const) {
    const value = parseCount(draft[field]);
    if (value === null) continue;
    if (Number.isNaN(value) || value < 1) errors[field] = POOL_OUT_OF_RANGE;
    else if (value > max) errors[field] = POOL_ABOVE_SLOTS;
  }
  if (draft.kinds.length === 0) errors.kinds = KEEP_ONE_KIND;
  return errors;
}

/** `PUT /api/settings/capacity`'s body (without the revision); blank fields are defaults. */
export function capacityBody(draft: CapacityDraft): Omit<CapacitySettingsBody, "revision"> {
  const count = (text: string) => parseCount(text);
  return {
    maxConcurrency: count(draft.slots),
    poolLimits: { long: count(draft.coding), short: count(draft.short) },
  };
}

/** `PUT /api/settings/kinds`'s body: every kind is left out, so a new kind is accepted too. */
export function kindsBody(draft: CapacityDraft): Omit<KindsSettingsBody, "revision"> {
  return draft.kinds.length === TASK_TYPES.length ? {} : { acceptedTaskTypes: [...draft.kinds] };
}

export function capacityChanged(saved: CapacityDraft, draft: CapacityDraft): boolean {
  return (["slots", "coding", "short"] as const).some(
    (field) => saved[field].trim() !== draft[field].trim(),
  );
}

export function kindsChanged(saved: CapacityDraft, draft: CapacityDraft): boolean {
  return saved.kinds.join() !== draft.kinds.join();
}

/** "3", or "5 (default)" for a blank field. */
function shown(text: string, value: number): string {
  return text.trim() === "" ? `${value} (default)` : String(value);
}

function countChange(
  id: CapacityField,
  label: string,
  fromText: string,
  toText: string,
  from: number,
  to: number,
  sentences: { lower: (to: number) => string; higher: (to: number) => string; same: string },
): StagedChange {
  return {
    id,
    label,
    from: String(from),
    to: shown(toText, to),
    effect: to < from ? sentences.lower(to) : to > from ? sentences.higher(to) : sentences.same,
  };
}

/** The save bar's items: each changed field with what saving it does. */
export function capacityChanges(saved: CapacityDraft, draft: CapacityDraft): StagedChange[] {
  const changes: StagedChange[] = [];
  if (saved.slots.trim() !== draft.slots.trim()) {
    changes.push(
      countChange(
        "slots",
        "Slots",
        saved.slots,
        draft.slots,
        draftSlots(saved),
        draftSlots(draft),
        {
          lower: (to) => `No new work starts until fewer than ${to} are running.`,
          higher: (to) => `Up to ${to} attempts run at the same time.`,
          same: "The number of slots stays the same.",
        },
      ),
    );
  }
  if (saved.coding.trim() !== draft.coding.trim()) {
    changes.push(
      countChange(
        "coding",
        "Coding slots",
        saved.coding,
        draft.coding,
        draftPoolLimit(saved, "long"),
        draftPoolLimit(draft, "long"),
        {
          lower: (to) => `No new coding attempt starts until fewer than ${to} are running.`,
          higher: (to) => `Up to ${to} coding attempts run at the same time.`,
          same: "The number of coding slots stays the same.",
        },
      ),
    );
  }
  if (saved.short.trim() !== draft.short.trim()) {
    changes.push(
      countChange(
        "short",
        "Review and ask slots",
        saved.short,
        draft.short,
        draftPoolLimit(saved, "short"),
        draftPoolLimit(draft, "short"),
        {
          lower: (to) => `No new review, ask or triage starts until fewer than ${to} are running.`,
          higher: (to) => `Up to ${to} reviews, asks and triage run at the same time.`,
          same: "The number of review and ask slots stays the same.",
        },
      ),
    );
  }
  for (const { kind, label } of KIND_OPTIONS) {
    const before = saved.kinds.includes(kind);
    const after = draft.kinds.includes(kind);
    if (before === after) continue;
    changes.push({
      id: `kind-${kind}`,
      label: `${label} work`,
      from: before ? "On" : "Off",
      to: after ? "On" : "Off",
      effect: after
        ? `${label} work is offered to this agent.`
        : `${label} work is no longer offered to this agent. Running attempts finish.`,
    });
  }
  return changes;
}
