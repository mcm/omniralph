/**
 * Model list prices (`model_prices`), with history: the daily refresh
 * (`apps/web/src/lib/cost/prices.ts`) hands the Gateway's current prices to `applyModelPrices`,
 * which keeps an unchanged price's row (checking it), closes a changed one and opens a new
 * row, and opens a first-seen model's row valid from `-infinity`. A model missing from the
 * list keeps its open row, so retired models stay priced.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import { modelPrices, organizations } from "./schema.js";

/** A model's current list price, USD per token as decimal strings (never floats). */
export interface ModelPriceInput {
  /** The Gateway's model ID, e.g. `anthropic/claude-opus-5.5`. */
  modelId: string;
  name: string;
  inputUsd: string;
  outputUsd: string;
  cacheReadUsd: string | null;
  /** 5-minute cache writes. */
  cacheWriteUsd: string | null;
  /** The base tier's prompt limit; null without tiers. */
  baseTierMaxTokens: number | null;
}

export interface ApplyModelPricesResult {
  /** First-seen models. */
  inserted: number;
  /** Models whose price changed (old row closed, new row opened). */
  changed: number;
  /** Models whose price is the same (only checked). */
  unchanged: number;
}

/**
 * A decimal string in canonical form ("0.0000040" → "0.000004", "4e-6" → "0.000004"), so a
 * stored numeric and a listed price compare equal when they are the same number.
 */
export function canonicalDecimal(value: string): string {
  const match = /^(\d*)(?:\.(\d*))?(?:e([-+]?\d+))?$/i.exec(value.trim());
  if (!match) throw new Error(`not a decimal: ${value}`);
  const [, whole = "", fraction = "", exponent = "0"] = match;
  let digits = `${whole}${fraction}`;
  let point = whole.length + Number(exponent);
  if (point < 0) {
    digits = "0".repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits += "0".repeat(point - digits.length);
  const intPart = digits.slice(0, point).replace(/^0+/, "") || "0";
  const fracPart = digits.slice(point).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

const samePrice = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : canonicalDecimal(a) === canonicalDecimal(b);

/**
 * Stores `prices` as of `now` in one transaction. A refresh that inserts or changes a price
 * records a `model_prices` change for every organization (any organization's figures may
 * change); an unchanged one records nothing.
 */
export async function applyModelPrices(
  db: Database,
  prices: readonly ModelPriceInput[],
  now: Date = new Date(),
): Promise<ApplyModelPricesResult> {
  return db.transaction(async (tx) => {
    const result: ApplyModelPricesResult = { inserted: 0, changed: 0, unchanged: 0 };
    const open = await tx
      .select({
        id: modelPrices.id,
        modelId: modelPrices.modelId,
        inputUsd: modelPrices.inputUsd,
        outputUsd: modelPrices.outputUsd,
        cacheReadUsd: modelPrices.cacheReadUsd,
        cacheWriteUsd: modelPrices.cacheWriteUsd,
        baseTierMaxTokens: modelPrices.baseTierMaxTokens,
      })
      .from(modelPrices)
      .where(isNull(modelPrices.validTo))
      .for("update");
    const current = new Map(open.map((row) => [row.modelId, row]));
    const seen = new Set<string>();
    for (const price of prices) {
      if (seen.has(price.modelId)) continue;
      seen.add(price.modelId);
      const values = {
        modelId: price.modelId,
        name: price.name,
        inputUsd: canonicalDecimal(price.inputUsd),
        outputUsd: canonicalDecimal(price.outputUsd),
        cacheReadUsd: price.cacheReadUsd === null ? null : canonicalDecimal(price.cacheReadUsd),
        cacheWriteUsd: price.cacheWriteUsd === null ? null : canonicalDecimal(price.cacheWriteUsd),
        baseTierMaxTokens: price.baseTierMaxTokens,
        checkedAt: now,
      };
      const row = current.get(price.modelId);
      if (!row) {
        // Attempts from before the model was first seen are priced at its first price.
        await tx
          .insert(modelPrices)
          .values({ ...values, validFrom: sql`'-infinity'::timestamptz` });
        result.inserted++;
      } else if (
        samePrice(row.inputUsd, values.inputUsd) &&
        samePrice(row.outputUsd, values.outputUsd) &&
        samePrice(row.cacheReadUsd, values.cacheReadUsd) &&
        samePrice(row.cacheWriteUsd, values.cacheWriteUsd) &&
        row.baseTierMaxTokens === values.baseTierMaxTokens
      ) {
        await tx
          .update(modelPrices)
          .set({ checkedAt: now, name: values.name })
          .where(eq(modelPrices.id, row.id));
        result.unchanged++;
      } else {
        await tx
          .update(modelPrices)
          .set({ validTo: now })
          .where(and(eq(modelPrices.id, row.id), isNull(modelPrices.validTo)));
        await tx.insert(modelPrices).values({ ...values, validFrom: now });
        result.changed++;
      }
    }
    if (result.inserted + result.changed > 0) {
      const orgs = await tx.select({ id: organizations.id }).from(organizations);
      for (const { id } of orgs) {
        // The event names its organization: prices aren't rows anyone can see.
        recordChange(tx, { resource: "model_prices", ids: [id], organizationId: id });
      }
    }
    return result;
  });
}
