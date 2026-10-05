const WAREHOUSE_URL = process.env.WAREHOUSE_URL ?? "http://warehouse.internal";

/** Tells the warehouse to pick an order. Rejects on network errors and non-2xx answers. */
export async function notifyWarehouse(orderId: string): Promise<void> {
  const response = await fetch(`${WAREHOUSE_URL}/picks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Warehouse answered ${response.status}`);
}
