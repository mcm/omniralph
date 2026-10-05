export type Currency = "USD" | "EUR" | "GBP";

/** Formats an amount in minor units (cents), e.g. 1999 → "$19.99". */
export function formatPrice(cents: number, currency: Currency = "USD", locale = "en-US"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

/** Formats large amounts compactly, e.g. 1_250_000_00 → "$1.3M". */
export function formatCompact(cents: number, currency: Currency = "USD", locale = "en-US"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(cents / 100);
}

/** Parses user input such as "19.99" or "1,299.50" into minor units; null if invalid. */
export function parsePrice(input: string): number | null {
  const normalized = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

/** Sums amounts in minor units. */
export function sumCents(amounts: readonly number[]): number {
  return amounts.reduce((total, cents) => total + cents, 0);
}
