// @omniralph/ui runs in plain React (the web app and the agent's local Vite UI), so it
// never imports Next.js, TanStack Query (each app has its own data layer) or the private
// @iamthemcmaster scope.
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
              group: ["@tanstack/*"],
              message:
                "@omniralph/ui has no data layer: apps bring their own (props and callbacks).",
            },
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
