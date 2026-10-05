import type { CartLine, Discount } from "./types.js";

/** Line total in cents, before discounts. */
export function lineTotal(line: CartLine): number {
  return line.unitPriceCents * line.quantity;
}

/** Cart total in cents with an optional discount, rounded per line. */
export function calcTotal(lines: readonly CartLine[], discount?: Discount): number {
  let total = 0;
  for (const line of lines) {
    const amount = lineTotal(line);
    const applies = discount && (discount.skus.length === 0 || discount.skus.includes(line.sku));
    total += applies ? Math.round(amount * (1 - discount.percent / 100)) : amount;
  }
  return total;
}
