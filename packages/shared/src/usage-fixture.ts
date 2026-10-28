/**
 * A recorded Agent SDK message sequence and the usage per model it reports, shared by the
 * tests of both session runners (the agent's `createSessionRunner` and the engine's
 * `ClaudeAgentProvider`), which must report the same `byModel` for it. Test-only
 * (`@omniralph/shared/testing`).
 */
import type { ModelTokenUsage } from "./usage.js";

const resultUsage = (u: {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  canonicalModel: string;
}) => ({ ...u, webSearchRequests: 0, costUSD: 0, contextWindow: 200_000, maxOutputTokens: 64_000 });

/**
 * One session: the main thread on Opus 5.5 (a 1-hour cache write, then a cache read; its
 * first message streamed twice), a subagent on Sonnet 5.5 (a 5-minute cache write), and
 * Haiku 4.5, which Claude Code called on its own: it appears only in the result's
 * `modelUsage`. The result's text is an empty review (`{"findings": []}`).
 */
export function usageSequence(options: { fastMode?: "on" | "off" | "cooldown" } = {}): unknown[] {
  return [
    {
      type: "assistant",
      parent_tool_use_id: null,
      uuid: "00000000-0000-4000-8000-000000000001",
      session_id: "usage-session",
      message: {
        id: "msg_main_1",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "Looking at the change." }],
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 0,
          output_tokens: 50,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5000 },
        },
      },
    },
    {
      // The same message streamed again, with its final output count.
      type: "assistant",
      parent_tool_use_id: null,
      uuid: "00000000-0000-4000-8000-000000000002",
      session_id: "usage-session",
      message: {
        id: "msg_main_1",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "Looking at the change." }],
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 0,
          output_tokens: 120,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5000 },
        },
      },
    },
    {
      type: "assistant",
      parent_tool_use_id: "toolu_subagent",
      uuid: "00000000-0000-4000-8000-000000000003",
      session_id: "usage-session",
      message: {
        id: "msg_sub_1",
        model: "claude-sonnet-5-5",
        content: [{ type: "text", text: "Subagent notes." }],
        usage: {
          input_tokens: 200,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 0,
          output_tokens: 30,
          cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 },
        },
      },
    },
    {
      type: "assistant",
      parent_tool_use_id: null,
      uuid: "00000000-0000-4000-8000-000000000004",
      session_id: "usage-session",
      message: {
        id: "msg_main_2",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: '{"findings": []}' }],
        usage: {
          input_tokens: 20,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 5000,
          output_tokens: 80,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 300 },
        },
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: '{"findings": []}',
      uuid: "00000000-0000-4000-8000-000000000005",
      session_id: "usage-session",
      fast_mode_state: options.fastMode ?? "off",
      modelUsage: {
        "claude-opus-5-5": resultUsage({
          inputTokens: 30,
          outputTokens: 200,
          cacheReadInputTokens: 5000,
          cacheCreationInputTokens: 5300,
          canonicalModel: "claude-opus-5-5",
        }),
        "claude-sonnet-5-5": resultUsage({
          inputTokens: 200,
          outputTokens: 30,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 1000,
          canonicalModel: "claude-sonnet-5-5",
        }),
        "claude-haiku-4-5-20251001": resultUsage({
          inputTokens: 400,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 600,
          canonicalModel: "claude-haiku-4-5",
        }),
      },
    },
  ];
}

/** What `usageSequence` reports per model. */
export function usageSequenceByModel(options: { fastMode?: boolean } = {}): ModelTokenUsage[] {
  const fastMode = options.fastMode ?? false;
  return [
    {
      model: "claude-opus-5-5",
      canonicalModel: "claude-opus-5-5",
      inputTokens: 30,
      cacheReadInputTokens: 5000,
      cacheCreationInputTokens: 5300,
      cacheWrite1hInputTokens: 5300,
      outputTokens: 200,
      largestRequestInputTokens: 5320,
      fastMode,
    },
    {
      model: "claude-sonnet-5-5",
      canonicalModel: "claude-sonnet-5-5",
      inputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 1000,
      cacheWrite1hInputTokens: 0,
      outputTokens: 30,
      largestRequestInputTokens: 1200,
      fastMode,
    },
    {
      // Never streamed: neither its 1-hour writes nor its largest request can be observed.
      model: "claude-haiku-4-5-20251001",
      canonicalModel: "claude-haiku-4-5",
      inputTokens: 400,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 600,
      cacheWrite1hInputTokens: null,
      outputTokens: 10,
      largestRequestInputTokens: null,
      fastMode,
    },
  ];
}

/** `usageSequence`'s totals as the runners report them (input includes cache reads and writes). */
export const USAGE_SEQUENCE_TOTALS = {
  inputTokens: 30 + 5000 + 5300 + 200 + 1000 + 400 + 600,
  outputTokens: 200 + 30 + 10,
};
