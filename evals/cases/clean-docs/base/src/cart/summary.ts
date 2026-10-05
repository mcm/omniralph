import { calcTotal } from "./total.js";
import type { CartLine, Discount } from "./types.js";

export interface CartSummary {
  itemCount: number;
  totalCents: number;
}

export function summarize(lines: readonly CartLine[], discount?: Discount): CartSummary {
  return {
    itemCount: lines.reduce((n, line) => n + line.quantity, 0),
    totalCents: calcTotal(lines, discount),
  };
}
