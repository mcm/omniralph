import { readdir } from "node:fs/promises";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionQueryFn, SessionRequest } from "../session/session.js";

/** The text of a streamed session's first user message (the prompt). */
export async function firstPrompt(prompt: AsyncIterable<SDKUserMessage>): Promise<string> {
  const first = await prompt[Symbol.asyncIterator]().next();
  if (first.done) return "";
  const content = first.value.message.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** What a scripted session saw when it started. */
export interface FakeSessionCall {
  prompt: string;
  options: Options;
  /** Files in the session's working directory when it started. */
  cwdFiles: string[];
}

/**
 * A fake SDK `query()` for `createSessionRunner`: records each session's
 * prompt, options and working directory, then yields what `respond` returns.
 */
export function scriptedQuery(
  respond: (call: FakeSessionCall) => AsyncIterable<SDKMessage> | Iterable<SDKMessage>,
): { query: SessionQueryFn; calls: FakeSessionCall[] } {
  const calls: FakeSessionCall[] = [];
  const query: SessionQueryFn = ({ prompt, options = {} }) =>
    (async function* () {
      const call: FakeSessionCall = {
        prompt: await firstPrompt(prompt),
        options,
        cwdFiles: options.cwd ? (await readdir(options.cwd)).sort() : [],
      };
      calls.push(call);
      yield* respond(call);
    })();
  return { query, calls };
}

/** A successful result frame with `usage` tokens (input/output). */
export function resultMessage(
  result: string,
  options: { structured?: unknown; inputTokens?: number; outputTokens?: number } = {},
): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    structured_output: options.structured,
    modelUsage: {
      opus: {
        inputTokens: options.inputTokens ?? 100,
        outputTokens: options.outputTokens ?? 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  } as unknown as SDKMessage;
}

/** A top-level assistant message with `text`, optional tool calls and usage. */
export function assistantMessage(
  text: string,
  options: { id?: string; toolUse?: boolean; inputTokens?: number; outputTokens?: number } = {},
): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: options.id ?? "msg",
      content: [
        { type: "text", text },
        ...(options.toolUse ? [{ type: "tool_use", id: "t1", name: "Read", input: {} }] : []),
      ],
      usage: {
        input_tokens: options.inputTokens ?? 0,
        output_tokens: options.outputTokens ?? 0,
      },
    },
  } as unknown as SDKMessage;
}

/** A session request for runners that only look at `onEvent` (and whatever `extra` sets). */
export function sessionRequest(extra: Partial<SessionRequest> = {}): SessionRequest {
  return { prompt: "p", cwd: "/tmp", ...extra } as SessionRequest;
}
