import nextVitals from "eslint-config-next/core-web-vitals";
import baseConfig from "../../eslint.config.js";
import designSystem from "./eslint-rules/design-system.mjs";

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
  {
    // Styling stays inside the design system (DESIGN.md): tokens and library primitives, not
    // raw colors, literal inline styles or arbitrary Tailwind values. An inline style that is
    // really dynamic is allowed with `// dynamic-style: <reason>` on the line before it.
    // At `warn` while the panel is migrated. Warnings per rule (TOOL-398, 2026-10-12):
    //   design-system/no-raw-color: 0
    //   design-system/no-inline-layout-style: 630
    //   design-system/no-arbitrary-tailwind: 0
    files: ["src/**/*.tsx"],
    ignores: ["src/**/*.test.tsx"],
    plugins: { "design-system": designSystem },
    rules: {
      "design-system/no-raw-color": "warn",
      "design-system/no-inline-layout-style": "warn",
      "design-system/no-arbitrary-tailwind": "warn",
    },
  },
];

export default config;
