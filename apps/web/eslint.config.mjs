import nextVitals from "eslint-config-next/core-web-vitals";
import baseConfig from "../../eslint.config.js";
import dataPath from "./eslint-rules/data-path.mjs";
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
    // Baseline when the rules were added at `warn` (TOOL-398, 2026-10-12): no-raw-color 0,
    // no-inline-layout-style 630, no-arbitrary-tailwind 0. Migrated to 0 and raised to `error`
    // (TOOL-432, 2026-10-12): 0 warnings per rule, so any new literal style fails `pnpm lint`.
    files: ["src/**/*.tsx"],
    ignores: ["src/**/*.test.tsx"],
    plugins: { "design-system": designSystem },
    rules: {
      "design-system/no-raw-color": "error",
      "design-system/no-inline-layout-style": "error",
      "design-system/no-arbitrary-tailwind": "error",
    },
  },
  {
    // DESIGN.md's Exact Values Rule: a timestamp on a page is mono and never wraps, so every
    // rendered formatDateTime(...) goes through <Timestamp> (TOOL-455). Strings (tooltips,
    // field descriptions) are left alone.
    files: ["src/app/(app)/**/*.tsx"],
    ignores: ["src/**/*.test.tsx"],
    plugins: { "design-system": designSystem },
    rules: {
      "design-system/no-bare-timestamp": "error",
    },
  },
  {
    // One data path for the signed-in pages (README "Data fetching", TOOL-522): client views
    // read and write through /api/ui with TanStack Query. No server actions, no
    // revalidatePath/revalidateTag and no database imports under (app), tests included; only
    // the layout's session gate reads the database (the user's organizations for AppShell).
    files: ["src/app/(app)/**/*.{ts,tsx}"],
    ignores: ["src/app/(app)/layout.tsx"],
    plugins: { "data-path": dataPath },
    rules: {
      "data-path/no-server-data": "error",
    },
  },
  {
    // Navigation feedback (TOOL-522): the panel's links show a pending state while their
    // page loads, through the Link in components/link.tsx (useLinkStatus).
    files: ["src/app/(app)/**/*.tsx", "src/components/**/*.tsx"],
    ignores: ["src/components/link.tsx", "src/components/auth-shell.tsx", "src/**/*.test.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "next/link",
              message: "Use Link from @/components/link: it shows the pending navigation.",
            },
          ],
        },
      ],
    },
  },
];

export default config;
