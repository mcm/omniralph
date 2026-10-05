import { calcTotal } from "./total.js";
import type { CartLine, Discount } from "./types.js";

export interface PaymentIntent {
  amountCents: number;
  currency: "USD";
}

export function paymentIntent(lines: readonly CartLine[], discount?: Discount): PaymentIntent {
  const amountCents = calcTotal(lines, discount);
  if (amountCents <= 0) throw new Error("Nothing to pay");
  return { amountCents, currency: "USD" };
}
