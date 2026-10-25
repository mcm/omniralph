// @omniralph/ui runs in plain React (the web app and the agent's local Vite UI), so it
// never imports Next.js or the private @iamthemcmaster scope.
import baseConfig from "../../eslint.config.js";

export default [
  ...baseConfig,
  {
    files: ["**/*.{js,ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "next", message: "@omniralph/ui must not depend on Next.js." }],
          patterns: [
            { group: ["next/*"], message: "@omniralph/ui must not depend on Next.js." },
            {
              group: ["@iamthemcmaster/*"],
              message: "@omniralph/ui must not depend on @iamthemcmaster packages.",
            },
          ],
        },
      ],
    },
  },
];
