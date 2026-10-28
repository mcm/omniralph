/**
 * Token usage of a session attempt: the totals every job result reports, and the usage per
 * model that prices it (`attempt_model_usage`, the control panel's `attempt_costs`).
 */
import { z } from "zod";

/** Most models one attempt may report (Claude Code uses two or three). */
export const MAX_USAGE_MODELS = 50;

const tokens = z.int().min(0);

/** One model's usage in a session, from the Agent SDK's result `modelUsage` and its streamed messages. */
export const ModelTokenUsage = z.object({
  /** The `modelUsage` key: the model as Claude Code reported it. */
  model: z.string().min(1).max(200),
  /** The ID Claude Code prices the model by (`modelUsage[…].canonicalModel`); null when unreported. */
  canonicalModel: z.string().min(1).max(200).nullable(),
  /** Uncached input only. */
  inputTokens: tokens,
  cacheReadInputTokens: tokens,
  /** Every cache write, 5-minute and 1-hour. */
  cacheCreationInputTokens: tokens,
  /** The 1-hour part of `cacheCreationInputTokens`; null when it couldn't be observed. */
  cacheWrite1hInputTokens: tokens.nullable(),
  outputTokens: tokens,
  /** The largest single request's prompt (input + cache reads + writes); null when unobserved. */
  largestRequestInputTokens: tokens.nullable(),
  /** Fast mode was on (or cooling down) during the session. */
  fastMode: z.boolean(),
});
export type ModelTokenUsage = z.infer<typeof ModelTokenUsage>;

/**
 * A job result's `usage`. `inputTokens` counts every input token, cache reads and writes
 * included; `byModel` (absent from sessionless results and from agents before it) splits it
 * per model.
 */
export const TokenUsage = z.object({
  inputTokens: tokens,
  outputTokens: tokens,
  byModel: z.array(ModelTokenUsage).max(MAX_USAGE_MODELS).optional(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/** No tokens (a result with no session). */
export const ZERO_USAGE: TokenUsage = Object.freeze({ inputTokens: 0, outputTokens: 0 });

const sumNullable = (a: number | null, b: number | null) =>
  a === null || b === null ? null : a + b;

/**
 * Two `byModel` lists as one (e.g. a review's tasks): entries of the same model add up, a
 * figure unknown in either is unknown, the largest request is the larger one.
 */
export function mergeModelUsage(
  a: readonly ModelTokenUsage[],
  b: readonly ModelTokenUsage[],
): ModelTokenUsage[] {
  const merged = new Map<string, ModelTokenUsage>();
  for (const entry of [...a, ...b]) {
    const prev = merged.get(entry.model);
    if (!prev) {
      merged.set(entry.model, { ...entry });
      continue;
    }
    merged.set(entry.model, {
      model: entry.model,
      canonicalModel: prev.canonicalModel ?? entry.canonicalModel,
      inputTokens: prev.inputTokens + entry.inputTokens,
      cacheReadInputTokens: prev.cacheReadInputTokens + entry.cacheReadInputTokens,
      cacheCreationInputTokens: prev.cacheCreationInputTokens + entry.cacheCreationInputTokens,
      cacheWrite1hInputTokens: sumNullable(
        prev.cacheWrite1hInputTokens,
        entry.cacheWrite1hInputTokens,
      ),
      outputTokens: prev.outputTokens + entry.outputTokens,
      largestRequestInputTokens:
        prev.largestRequestInputTokens === null || entry.largestRequestInputTokens === null
          ? null
          : Math.max(prev.largestRequestInputTokens, entry.largestRequestInputTokens),
      fastMode: prev.fastMode || entry.fastMode,
    });
  }
  return [...merged.values()];
}

/** Two usages as one: totals add up and `byModel` merges (absent when neither has one). */
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const byModel =
    a.byModel || b.byModel ? mergeModelUsage(a.byModel ?? [], b.byModel ?? []) : undefined;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(byModel && { byModel }),
  };
}

/**
 * The AI Gateway model ID (`anthropic/claude-opus-5.5`) of a canonical Claude model ID, or
 * null for anything else: aliases (`opus`), old `claude-3-5-sonnet-…` IDs, unknown families.
 * Drops a bracketed suffix (`[1m]`), a date suffix (`-20251001`) and a provider prefix
 * (`anthropic/`, `us.anthropic.`). Only reported models go through it, never requested ones.
 */
export function gatewayModelId(name: string): string | null {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/^(?:[a-z0-9-]+\.)*anthropic[./]/, "");
  const match = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d))?$/.exec(id);
  if (!match) return null;
  const [, family, major, minor] = match;
  return `anthropic/claude-${family}-${major}${minor ? `.${minor}` : ""}`;
}

/** The parts of a streamed assistant message the tracker reads (`SDKAssistantMessage.message`). */
export interface StreamedModelMessage {
  /** The API message ID; streamed messages repeat it. */
  id?: string;
  model?: string;
  usage?: unknown;
}

/** The parts of one `modelUsage` entry the tracker reads (the SDK's `ModelUsage`). */
export interface ResultModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  canonicalModel?: string;
}

/** The parts of a result message the tracker reads (`SDKResultMessage`). */
export interface ResultUsageMessage {
  modelUsage?: Record<string, ResultModelUsage>;
  fast_mode_state?: string;
}

interface StreamedUsage {
  model: string;
  input: number;
  cacheRead: number;
  cacheCreation: number;
  /** Null when the message has cache writes but no 1-hour split. */
  cache1h: number | null;
  output: number;
}

interface ModelTotals {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  cache1h: number | null;
  output: number;
  largest: number | null;
  canonical: string | null;
}

/** One `query()` call: its streamed messages and its latest result totals. */
interface QuerySegment {
  messages: Map<string, StreamedUsage>;
  results: Map<string, ResultModelUsage>;
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** "claude-opus-5-5[1m]" and "claude-opus-5-5" are the same model. */
const baseName = (model: string) => model.toLowerCase().replace(/\[[^\]]*\]$/, "");

const maxNullable = (a: number | null, b: number | null) =>
  a === null || b === null ? null : Math.max(a, b);

/**
 * Usage per model of a session, from the Agent SDK's messages: each streamed assistant
 * message (de-duplicated by its ID) gives its model's prompt sizes and 1-hour cache writes;
 * each result's `modelUsage` gives the per-model totals, including models Claude Code calls
 * on its own and never streams.
 *
 * Within one `query()` call the results' `modelUsage` is cumulative (each result carries the
 * running total, per the SDK), so the latest counts; separate calls (`startQuery`, e.g. a
 * review's repair turn) add up. A model's figure is never less than what its streamed
 * messages add up to.
 */
export class UsageByModelTracker {
  private readonly segments: QuerySegment[] = [];
  private anonymous = 0;
  private fastMode = false;

  /** Starts another `query()` call, whose usage adds to the earlier calls'. */
  startQuery(): void {
    this.segments.push({ messages: new Map(), results: new Map() });
  }

  private get current(): QuerySegment {
    if (this.segments.length === 0) this.startQuery();
    return this.segments.at(-1)!;
  }

  /** Records a streamed assistant message (`message.message`); `key` stands in for a missing ID. */
  recordMessage(message: StreamedModelMessage, key?: string): void {
    const raw = message.usage;
    if (!message.model || !raw || typeof raw !== "object") return;
    const usage = raw as Record<string, unknown>;
    const cacheCreation = count(usage.cache_creation_input_tokens);
    const split = usage.cache_creation as Record<string, unknown> | null | undefined;
    const hasSplit = !!split && typeof split === "object" && "ephemeral_1h_input_tokens" in split;
    const next: StreamedUsage = {
      model: message.model,
      input: count(usage.input_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      cacheCreation,
      cache1h: hasSplit
        ? Math.min(count(split.ephemeral_1h_input_tokens), cacheCreation)
        : cacheCreation > 0
          ? null
          : 0,
      output: count(usage.output_tokens),
    };
    const id = message.id ?? key ?? `anonymous-${this.anonymous++}`;
    const messages = this.current.messages;
    const prev = messages.get(id);
    messages.set(
      id,
      prev
        ? {
            model: next.model,
            input: Math.max(prev.input, next.input),
            cacheRead: Math.max(prev.cacheRead, next.cacheRead),
            cacheCreation: Math.max(prev.cacheCreation, next.cacheCreation),
            // A later frame with the split settles one without it.
            cache1h:
              prev.cache1h === null || next.cache1h === null
                ? (next.cache1h ?? prev.cache1h)
                : Math.max(prev.cache1h, next.cache1h),
            output: Math.max(prev.output, next.output),
          }
        : next,
    );
  }

  /** Records a result message: its `modelUsage` totals and its fast mode state. */
  recordResult(message: ResultUsageMessage): void {
    if (message.fast_mode_state === "on" || message.fast_mode_state === "cooldown") {
      this.fastMode = true;
    }
    const results = this.current.results;
    for (const [model, usage] of Object.entries(message.modelUsage ?? {})) {
      const prev = results.get(model);
      results.set(model, {
        inputTokens: Math.max(prev?.inputTokens ?? 0, count(usage.inputTokens)),
        outputTokens: Math.max(prev?.outputTokens ?? 0, count(usage.outputTokens)),
        cacheReadInputTokens: Math.max(
          prev?.cacheReadInputTokens ?? 0,
          count(usage.cacheReadInputTokens),
        ),
        cacheCreationInputTokens: Math.max(
          prev?.cacheCreationInputTokens ?? 0,
          count(usage.cacheCreationInputTokens),
        ),
        ...((usage.canonicalModel ?? prev?.canonicalModel)
          ? { canonicalModel: usage.canonicalModel ?? prev?.canonicalModel }
          : {}),
      });
    }
  }

  /** Usage per model so far: the results' models in their order, then models only streamed. */
  get byModel(): ModelTokenUsage[] {
    const totals = new Map<string, ModelTotals>();
    for (const segment of this.segments) {
      for (const [model, t] of segmentTotals(segment)) {
        const prev = totals.get(model);
        totals.set(
          model,
          prev
            ? {
                input: prev.input + t.input,
                cacheRead: prev.cacheRead + t.cacheRead,
                cacheCreation: prev.cacheCreation + t.cacheCreation,
                cache1h: sumNullable(prev.cache1h, t.cache1h),
                output: prev.output + t.output,
                largest: maxNullable(prev.largest, t.largest),
                canonical: prev.canonical ?? t.canonical,
              }
            : t,
        );
      }
    }
    return [...totals].map(([model, t]) => ({
      model,
      canonicalModel: t.canonical,
      inputTokens: t.input,
      cacheReadInputTokens: t.cacheRead,
      cacheCreationInputTokens: t.cacheCreation,
      cacheWrite1hInputTokens: t.cache1h,
      outputTokens: t.output,
      largestRequestInputTokens: t.largest,
      fastMode: this.fastMode,
    }));
  }
}

/** One `query()` call's usage per model: its result's totals, floored by its streamed messages. */
function segmentTotals(segment: QuerySegment): Map<string, ModelTotals> {
  const streamed = new Map<string, ModelTotals>();
  for (const m of segment.messages.values()) {
    const prev = streamed.get(m.model);
    const prompt = m.input + m.cacheRead + m.cacheCreation;
    streamed.set(
      m.model,
      prev
        ? {
            input: prev.input + m.input,
            cacheRead: prev.cacheRead + m.cacheRead,
            cacheCreation: prev.cacheCreation + m.cacheCreation,
            cache1h: sumNullable(prev.cache1h, m.cache1h),
            output: prev.output + m.output,
            largest: Math.max(prev.largest ?? 0, prompt),
            canonical: null,
          }
        : {
            input: m.input,
            cacheRead: m.cacheRead,
            cacheCreation: m.cacheCreation,
            cache1h: m.cache1h,
            output: m.output,
            largest: prompt,
            canonical: null,
          },
    );
  }

  // The result's key for each streamed model: the same name, or the same model ("[1m]").
  const keys = [...segment.results.keys()];
  const resultKey = (model: string) =>
    segment.results.has(model)
      ? model
      : keys.find(
          (key) =>
            baseName(key) === baseName(model) ||
            segment.results.get(key)?.canonicalModel?.toLowerCase() === baseName(model),
        );

  const totals = new Map<string, ModelTotals>();
  const seen = new Map<string, ModelTotals>();
  for (const [model, s] of streamed) {
    const key = resultKey(model) ?? model;
    const prev = seen.get(key);
    seen.set(
      key,
      prev
        ? {
            input: prev.input + s.input,
            cacheRead: prev.cacheRead + s.cacheRead,
            cacheCreation: prev.cacheCreation + s.cacheCreation,
            cache1h: sumNullable(prev.cache1h, s.cache1h),
            output: prev.output + s.output,
            largest: maxNullable(prev.largest, s.largest),
            canonical: null,
          }
        : s,
    );
  }
  for (const [model, r] of segment.results) {
    const s = seen.get(model);
    const cacheCreation = Math.max(r.cacheCreationInputTokens, s?.cacheCreation ?? 0);
    totals.set(model, {
      input: Math.max(r.inputTokens, s?.input ?? 0),
      cacheRead: Math.max(r.cacheReadInputTokens, s?.cacheRead ?? 0),
      cacheCreation,
      // Cache writes the streamed messages don't account for have no observable split.
      cache1h:
        cacheCreation === 0
          ? 0
          : s && s.cache1h !== null && s.cacheCreation >= cacheCreation
            ? s.cache1h
            : null,
      output: Math.max(r.outputTokens, s?.output ?? 0),
      largest: s?.largest ?? null,
      canonical: r.canonicalModel ?? null,
    });
  }
  // Streamed models with no result (the session stopped before one) count as streamed.
  for (const [model, s] of seen) if (!totals.has(model)) totals.set(model, s);
  return totals;
}
