import "server-only";
/**
 * Anthropic model list prices from the Vercel AI Gateway's public model list
 * (`GET https://ai-gateway.vercel.sh/v1/models`, no authentication), stored with history in
 * `model_prices` by the daily cron (`/api/cron/model-prices`). Attempts are priced from them
 * at read time (`attempt_costs`).
 */
import {
  applyModelPrices,
  type ApplyModelPricesResult,
  type Database,
  type ModelPriceInput,
} from "@omniralph/db";
import { z } from "zod";

export const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";

/** A fetch of the model list that takes longer than this fails. */
export const GATEWAY_FETCH_TIMEOUT_MS = 10_000;

/** USD per token, as the Gateway writes it: a decimal string, kept as text (never a float). */
const decimal = z.string().regex(/^\d*\.?\d+(?:e[-+]?\d+)?$/i, "not a decimal price");

const tier = z.object({
  cost: decimal,
  min: z.number().int().min(0),
  max: z.number().int().positive().optional(),
});

/** The pricing of one model; each component may have long-context tiers. */
const pricing = z.object({
  input: decimal,
  output: decimal,
  input_cache_read: decimal.optional(),
  input_cache_write: decimal.optional(),
  input_tiers: z.array(tier).optional(),
  output_tiers: z.array(tier).optional(),
  input_cache_read_tiers: z.array(tier).optional(),
  input_cache_write_tiers: z.array(tier).optional(),
});

const gatewayModel = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  owned_by: z.string().optional(),
  type: z.string().optional(),
  pricing: z.unknown().optional(),
});

/** The model list's shape; each Anthropic language model's pricing is parsed on its own. */
const gatewayModels = z.object({ data: z.array(gatewayModel) });

type Pricing = z.infer<typeof pricing>;
type Tier = z.infer<typeof tier>;

/** A component's base price: its tier starting at 0 when it has tiers, else its flat price. */
function basePrice(
  flat: string | undefined,
  tiers: Tier[] | undefined,
): { usd: string | null; max: number | null } | undefined {
  if (!tiers || tiers.length === 0) return { usd: flat ?? null, max: null };
  const base = tiers.find((t) => t.min === 0);
  return base ? { usd: base.cost, max: base.max ?? null } : undefined;
}

/**
 * The price row of a listed model, or null when it isn't one Omniralph stores: not an
 * Anthropic language model, a batch variant, or pricing that doesn't parse or has no base
 * tier. Fast variants (`-fast`) are stored, but no attempt's model maps to them.
 */
export function modelPriceOf(model: z.infer<typeof gatewayModel>): ModelPriceInput | null {
  if (model.owned_by !== "anthropic" || model.type !== "language") return null;
  if (model.id.endsWith("-batch")) return null;
  const parsed = pricing.safeParse(model.pricing);
  if (!parsed.success) return null;
  const p: Pricing = parsed.data;
  const input = basePrice(p.input, p.input_tiers);
  const output = basePrice(p.output, p.output_tiers);
  const cacheRead = basePrice(p.input_cache_read, p.input_cache_read_tiers);
  const cacheWrite = basePrice(p.input_cache_write, p.input_cache_write_tiers);
  if (!input?.usd || !output?.usd || !cacheRead || !cacheWrite) return null;
  const limits = [input, output, cacheRead, cacheWrite]
    .map((c) => c.max)
    .filter((max): max is number => max !== null);
  return {
    modelId: model.id,
    name: model.name ?? model.id,
    inputUsd: input.usd,
    outputUsd: output.usd,
    cacheReadUsd: cacheRead.usd,
    cacheWriteUsd: cacheWrite.usd,
    baseTierMaxTokens: limits.length > 0 ? Math.min(...limits) : null,
  };
}

/** Fetches and parses the Gateway's model list: the price of every model Omniralph stores. */
export async function fetchModelPrices(fetchFn: typeof fetch = fetch): Promise<ModelPriceInput[]> {
  const response = await fetchFn(GATEWAY_MODELS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`the AI Gateway answered ${response.status}`);
  const list = gatewayModels.parse(await response.json());
  return list.data.map(modelPriceOf).filter((p): p is ModelPriceInput => p !== null);
}

export type RefreshModelPricesResult =
  { ok: true; result: ApplyModelPricesResult } | { ok: false; error: string };

/**
 * Refreshes `model_prices` from the Gateway: an unchanged price is only checked, a changed
 * one closes its row and opens a new one, a first-seen model is valid from `-infinity`, and a
 * model missing from the list keeps its price. A failed fetch or parse changes nothing. A
 * refresh that inserts or changes a price publishes a `model_prices` change per organization.
 */
export async function refreshModelPrices(deps: {
  db: Database;
  fetch?: typeof fetch;
  now?: Date;
}): Promise<RefreshModelPricesResult> {
  let prices: ModelPriceInput[];
  try {
    prices = await fetchModelPrices(deps.fetch);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Refreshing model prices failed: the AI Gateway model list", error);
    return { ok: false, error: message };
  }
  return { ok: true, result: await applyModelPrices(deps.db, prices, deps.now ?? new Date()) };
}
