/**
 * The unsaved changes of a settings card: which of its settings differ from
 * the saved ones, as the "old → new" list its save confirmation shows.
 */

/** A setting's value once the form's text is parsed (lists, numbers, flags). */
export type SettingValue = string | number | boolean | readonly string[] | null;

/** How a setting is named and shown in the change list. */
export interface SettingSpec<K extends string = string> {
  key: K;
  /** The setting's label as the form shows it. */
  label: string;
  /** Shows a value; `formatSettingValue` when omitted. */
  format?: (value: SettingValue) => string;
}

/** One changed setting. */
export interface SettingChange {
  key: string;
  label: string;
  from: string;
  to: string;
}

/**
 * How the panel words a setting with no value, in descriptions ("Default: not set.") and in the
 * change list ("Not set"). One wording everywhere, never "none", "empty" or "blank".
 */
export const NOT_SET = "not set";

/** A value as the change list shows it: On/Off, "Not set" for empty, lists comma-separated. */
export function formatSettingValue(value: SettingValue): string {
  if (value === null) return "Not set";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toLocaleString("en-US") : "Not a number";
  }
  if (typeof value === "string") return value.trim() === "" ? "Not set" : value;
  return value.length === 0 ? "Not set" : value.join(", ");
}

/** Longest text the change list shows whole; longer or multi-line text is summarized. */
const SHORT_TEXT = 80;

/**
 * A text setting that may be long (a prompt, a document) as the change list shows it: whole when
 * it is short and on one line, else its size ("12 lines, 840 characters").
 */
export function formatLongText(value: SettingValue): string {
  if (typeof value !== "string" || value.trim() === "") return formatSettingValue(value);
  if (value.length <= SHORT_TEXT && !value.includes("\n")) return value;
  return textSize(value);
}

/** A text's size: "12 lines, 840 characters". */
export function textSize(text: string): string {
  const count = (n: number, noun: string) =>
    `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
  return `${count(text.split("\n").length, "line")}, ${count(text.length, "character")}`;
}

/** Whether two setting values are the same (lists element by element, in order). */
export function sameSettingValue(a: SettingValue, b: SettingValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => item === b[index]);
  }
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  return a === b;
}

/** The settings of `specs` whose value differs between `saved` and `draft`, in spec order. */
export function settingChanges<K extends string>(
  specs: readonly SettingSpec<K>[],
  saved: Readonly<Record<K, SettingValue>>,
  draft: Readonly<Record<K, SettingValue>>,
): SettingChange[] {
  return specs.flatMap((spec) => {
    const from = saved[spec.key];
    const to = draft[spec.key];
    if (sameSettingValue(from, to)) return [];
    const format = spec.format ?? formatSettingValue;
    return [{ key: spec.key, label: spec.label, from: format(from), to: format(to) }];
  });
}

/** `errors` without those of `keys` (a list field's errors are keyed `field.n`). */
export function withoutFieldErrors(
  errors: Readonly<Record<string, string>>,
  keys: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors).filter(
      ([key]) => !keys.some((field) => key === field || key.startsWith(`${field}.`)),
    ),
  );
}

/** A setting's description followed by its default: "… Default: 3." (`NOT_SET` when omitted). */
export function withDefault(description: string, defaultValue: string = NOT_SET): string {
  return `${description} Default: ${defaultValue}.`;
}
