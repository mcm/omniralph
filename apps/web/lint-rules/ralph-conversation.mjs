// Local lint rule: Ralph session writes go through RunConversation, so chat runs post to
// their thread (docs/adr/0003-ralph-orchestration.md). Code outside conversation.ts and the
// tracker client doesn't call the tracker gateway's session-writing methods
// (`gateway.sessions.createActivity`, ...) itself; the config exempts those.
// Tested in ralph-conversation.test.ts; wired up in apps/web/.oxlintrc.json.

/** @typedef {Parameters<import("oxlint/plugins-dev").RuleTester["run"]>[1]} Rule */

const SESSION_WRITES = new Set(["createActivity", "updatePlan", "addExternalUrl"]);

/** Whether the node is the gateway's sessions capability: `x.sessions` or a `sessions` binding. */
function isSessions(node) {
  if (node.type === "Identifier") return node.name === "sessions";
  if (node.type === "ChainExpression") return isSessions(node.expression);
  return (
    node.type === "MemberExpression" &&
    node.property.type === "Identifier" &&
    node.property.name === "sessions"
  );
}

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
        if (
          node.property.type === "Identifier" &&
          SESSION_WRITES.has(node.property.name) &&
          isSessions(node.object)
        ) {
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
