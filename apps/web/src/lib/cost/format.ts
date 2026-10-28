/**
 * How the control panel shows a list price (Runs and Analytics). Client-safe.
 */

/** What every Cost figure means (its tooltip). */
export const COST_NOTE =
  "What these tokens would cost at Anthropic's API list prices, not what was billed.";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * US dollars with two decimals, e.g. "$1,234.50". An amount above 0 and below a cent is
 * "<$0.01", since "$0.00" would read as free; exactly 0 is "$0.00".
 */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "<$0.01";
  return usd.format(amount);
}
