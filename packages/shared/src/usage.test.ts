import { describe, expect, it } from "vitest";
import { usageSequence, usageSequenceByModel } from "./usage-fixture.js";
import {
  addTokenUsage,
  gatewayModelId,
  mergeModelUsage,
  TokenUsage,
  UsageByModelTracker,
  type ModelTokenUsage,
  type ResultUsageMessage,
  type StreamedModelMessage,
} from "./usage.js";

/** Feeds an SDK message sequence to a tracker as both session runners do. */
function track(messages: unknown[], tracker = new UsageByModelTracker()): UsageByModelTracker {
  for (const message of messages as { type: string; message?: StreamedModelMessage }[]) {
    if (message.type === "assistant") tracker.recordMessage(message.message!);
    if (message.type === "result") tracker.recordResult(message as ResultUsageMessage);
  }
  return tracker;
}

const entry = (overrides: Partial<ModelTokenUsage> = {}): ModelTokenUsage => ({
  model: "claude-opus-5-5",
  canonicalModel: "claude-opus-5-5",
  inputTokens: 1,
  cacheReadInputTokens: 2,
  cacheCreationInputTokens: 3,
  cacheWrite1hInputTokens: 1,
  outputTokens: 4,
  largestRequestInputTokens: 6,
  fastMode: false,
  ...overrides,
});

describe("gatewayModelId", () => {
  it.each([
    ["claude-opus-5-5", "anthropic/claude-opus-5.5"],
    ["claude-haiku-4-5-20251001", "anthropic/claude-haiku-4.5"],
    ["claude-opus-5", "anthropic/claude-opus-5"],
    ["claude-opus-4-20250514", "anthropic/claude-opus-4"],
    ["Claude-Sonnet-5-5", "anthropic/claude-sonnet-5.5"],
    ["claude-opus-5-5[1m]", "anthropic/claude-opus-5.5"],
    ["claude-sonnet-4-5-20250929[1m]", "anthropic/claude-sonnet-4.5"],
    ["anthropic/claude-fable-5-1", "anthropic/claude-fable-5.1"],
    ["us.anthropic.claude-mythos-5", "anthropic/claude-mythos-5"],
  ])("maps %s to %s", (name, id) => {
    expect(gatewayModelId(name)).toBe(id);
  });

  it.each([
    "opus",
    "sonnet",
    "haiku",
    "opus[1m]",
    "claude-3-5-sonnet-20241022",
    "claude-3-opus-20240229",
    "claude-instant-1-2",
    "gpt-5",
    "claude-opus",
    "claude-opus-5-55",
    "",
  ])("returns null for %j", (name) => {
    expect(gatewayModelId(name)).toBeNull();
  });
});

describe("TokenUsage", () => {
  it("keeps today's totals and an optional byModel", () => {
    expect(TokenUsage.parse({ inputTokens: 5, outputTokens: 1 })).toEqual({
      inputTokens: 5,
      outputTokens: 1,
    });
    const byModel = usageSequenceByModel();
    expect(TokenUsage.parse({ inputTokens: 5, outputTokens: 1, byModel })).toEqual({
      inputTokens: 5,
      outputTokens: 1,
      byModel,
    });
    expect(
      TokenUsage.safeParse({
        inputTokens: 5,
        outputTokens: 1,
        byModel: [{ ...byModel[0], inputTokens: -1 }],
      }).success,
    ).toBe(false);
  });
});

describe("UsageByModelTracker", () => {
  it("reports each model of a recorded session", () => {
    expect(track(usageSequence()).byModel).toEqual(usageSequenceByModel());
  });

  it("marks every model fast mode when a result reports it on or cooling down", () => {
    expect(track(usageSequence({ fastMode: "on" })).byModel).toEqual(
      usageSequenceByModel({ fastMode: true }),
    );
    expect(track(usageSequence({ fastMode: "cooldown" })).byModel).toEqual(
      usageSequenceByModel({ fastMode: true }),
    );
  });

  it("takes the latest of one query's cumulative results, and adds up separate queries", () => {
    const sequence = usageSequence();
    const result = sequence.at(-1) as ResultUsageMessage & Record<string, unknown>;
    // A follow-up turn: another Opus message, and a result carrying the running total.
    const followUp = [
      {
        type: "assistant",
        message: {
          id: "msg_main_3",
          model: "claude-opus-5-5",
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 5300,
            cache_creation_input_tokens: 0,
            output_tokens: 40,
          },
        },
      },
      {
        ...result,
        modelUsage: {
          ...result.modelUsage,
          "claude-opus-5-5": {
            ...result.modelUsage!["claude-opus-5-5"]!,
            inputTokens: 35,
            cacheReadInputTokens: 10_300,
            outputTokens: 240,
          },
        },
      },
    ];
    const [opus, ...rest] = usageSequenceByModel();
    expect(track([...sequence, ...followUp]).byModel).toEqual([
      { ...opus, inputTokens: 35, cacheReadInputTokens: 10_300, outputTokens: 240 },
      ...rest,
    ]);

    // Two `query()` calls (a review and its repair turn) add up.
    const tracker = new UsageByModelTracker();
    tracker.startQuery();
    track(sequence, tracker);
    tracker.startQuery();
    track(sequence, tracker);
    expect(tracker.byModel).toEqual(
      mergeModelUsage(usageSequenceByModel(), usageSequenceByModel()),
    );
    expect(tracker.byModel[0]).toMatchObject({
      inputTokens: 60,
      cacheWrite1hInputTokens: 10_600,
      largestRequestInputTokens: 5320,
    });
  });

  it("matches a streamed model to its result key with a bracket suffix", () => {
    const tracker = new UsageByModelTracker();
    tracker.recordMessage({
      id: "m1",
      model: "claude-opus-5-5",
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 3 },
    });
    tracker.recordResult({
      modelUsage: {
        "claude-opus-5-5[1m]": {
          inputTokens: 10,
          outputTokens: 3,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          canonicalModel: "claude-opus-5-5",
        },
      },
    });
    expect(tracker.byModel).toEqual([
      entry({
        model: "claude-opus-5-5[1m]",
        inputTokens: 10,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        outputTokens: 3,
        largestRequestInputTokens: 10,
      }),
    ]);
  });

  it("leaves the 1-hour split unknown when a streamed message has cache writes but no split", () => {
    const tracker = new UsageByModelTracker();
    tracker.recordMessage({
      id: "m1",
      model: "claude-opus-5-5",
      usage: { input_tokens: 1, cache_creation_input_tokens: 50, output_tokens: 2 },
    });
    expect(tracker.byModel).toEqual([
      entry({
        canonicalModel: null,
        inputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 50,
        cacheWrite1hInputTokens: null,
        outputTokens: 2,
        largestRequestInputTokens: 51,
      }),
    ]);
  });

  it("reports streamed models of a session that stopped before its result", () => {
    const streamed = usageSequence().slice(0, -1);
    expect(track(streamed).byModel.map((m) => [m.model, m.inputTokens, m.canonicalModel])).toEqual([
      ["claude-opus-5-5", 30, null],
      ["claude-sonnet-5-5", 200, null],
    ]);
  });

  it("reports nothing before any message", () => {
    expect(new UsageByModelTracker().byModel).toEqual([]);
  });
});

describe("merging usage", () => {
  it("adds up entries of the same model, keeping unknown figures unknown", () => {
    expect(
      mergeModelUsage(
        [entry(), entry({ model: "claude-haiku-4-5" })],
        [entry({ cacheWrite1hInputTokens: null, largestRequestInputTokens: 9, fastMode: true })],
      ),
    ).toEqual([
      entry({
        inputTokens: 2,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 6,
        cacheWrite1hInputTokens: null,
        outputTokens: 8,
        largestRequestInputTokens: 9,
        fastMode: true,
      }),
      entry({ model: "claude-haiku-4-5" }),
    ]);
  });

  it("adds totals, with byModel only when one side has it", () => {
    expect(
      addTokenUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 }),
    ).toEqual({ inputTokens: 4, outputTokens: 6 });
    expect(
      addTokenUsage(
        { inputTokens: 1, outputTokens: 2 },
        { inputTokens: 3, outputTokens: 4, byModel: [entry()] },
      ),
    ).toEqual({ inputTokens: 4, outputTokens: 6, byModel: [entry()] });
  });
});
