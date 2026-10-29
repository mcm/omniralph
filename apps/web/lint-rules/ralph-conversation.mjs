// Local lint rule: Ralph session writes go through RunConversation, so chat runs post to
// their thread (docs/adr/0003-ralph-orchestration.md). Code outside conversation.ts and the
// Linear client doesn't call the session-writing methods itself; the config exempts those.
// Tested in ralph-conversation.test.ts; wired up in apps/web/.oxlintrc.json.

/** @typedef {Parameters<import("oxlint/plugins-dev").RuleTester["run"]>[1]} Rule */

const SESSION_WRITES = new Set(["createActivity", "updateSessionPlan", "addSessionExternalUrl"]);

/** @type {Rule} */
export const noDirectSessionWrite = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow writing to a ralph session except through conversationFor",
    },
    schema: [],
    messages: {
      direct:
        "Write to a ralph session through conversationFor(run, deps) (src/lib/ralph/conversation.ts).",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (node.property.type === "Identifier" && SESSION_WRITES.has(node.property.name)) {
          context.report({ node, messageId: "direct" });
        }
      },
    };
  },
};

const plugin = {
  meta: { name: "ralph-conversation" },
  rules: { "no-direct-session-write": noDirectSessionWrite },
};

export default plugin;
