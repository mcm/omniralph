/** ` (N tokens)` for a run's token budget, quoted when it ran out; empty for "No limit". */
export function tokenCount(budgetTokens: number | null): string {
  return budgetTokens === null ? "" : ` (${budgetTokens.toLocaleString("en-US")} tokens)`;
}
