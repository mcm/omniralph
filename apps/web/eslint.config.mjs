import nextVitals from "eslint-config-next/core-web-vitals";
import baseConfig from "../../eslint.config.js";

const config = [
  ...nextVitals,
  ...baseConfig,
  {
    // Job delivery stays behind the JobDispatcher interface (docs/adr/0001-job-dispatch.md).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/dispatch/**", "src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@vercel/queue",
              message: "Only src/lib/dispatch may use @vercel/queue; use getDispatcher().",
            },
          ],
        },
      ],
    },
  },
];

export default config;
