import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** The text of a streamed session's first user message (the prompt). */
export async function firstPrompt(prompt: AsyncIterable<SDKUserMessage>): Promise<string> {
  const first = await prompt[Symbol.asyncIterator]().next();
  if (first.done) return "";
  const content = first.value.message.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}
