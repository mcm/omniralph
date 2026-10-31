/** A token count in compact form: "950", "8.4k", "225k", "45.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A run's tokens: "45.2M in · 225k out". */
export function tokensText(tokens: { in: number; out: number }): string {
  return `${formatTokens(tokens.in)} in · ${formatTokens(tokens.out)} out`;
}

/** A run's attempt count: "1 attempt", "3 attempts". */
export function attemptsText(count: number): string {
  return count === 1 ? "1 attempt" : `${count} attempts`;
}
