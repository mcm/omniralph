import { db } from "../db.js";
import type { Cart, Order } from "./types.js";

export async function placeOrder(cart: Cart): Promise<Order> {
  if (cart.items.length === 0) throw new Error("Cart is empty");
  const order = await db.order.create({
    data: {
      customerId: cart.customerId,
      status: "placed",
      items: { create: cart.items.map((i) => ({ sku: i.sku, quantity: i.quantity })) },
    },
  });
  return order;
}
