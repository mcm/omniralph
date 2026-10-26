/** Number inputs of the settings forms: what the input holds and how a count is shown. */

/** A number typed into a number input; NaN (rejected by the schemas) when it isn't a number. */
export function typedNumber(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

/** A large count as the form shows it, with separators: 60000 → "60,000". */
export function groupedNumber(value: number): string {
  return value.toLocaleString("en-US");
}
