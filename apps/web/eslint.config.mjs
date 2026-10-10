import nextVitals from "eslint-config-next/core-web-vitals";
import baseConfig from "../../eslint.config.js";

const config = [
  ...nextVitals,
  ...baseConfig,
  {
    // Ralph session writes go through RunConversation, so chat runs post to their thread
    // (docs/adr/0003-ralph-orchestration.md).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/linear/**", "src/lib/ralph/conversation.ts", "src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[property.name=/^(createActivity|updateSessionPlan|addSessionExternalUrl)$/]",
          message:
            "Write to a ralph session through conversationFor(run, deps) (src/lib/ralph/conversation.ts).",
        },
      ],
    },
  },
];

export default config;
