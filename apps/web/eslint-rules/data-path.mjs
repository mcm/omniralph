// Local ESLint rule that keeps the signed-in pages (`src/app/(app)`) on one data path:
// client views reading `/api/ui` through TanStack Query (README "Data fetching"). No server
// actions, no `revalidatePath`/`revalidateTag`, no database imports; only the signed-in
// layout's session gate reads the database, and the config exempts it.
// Tested in data-path.test.ts; wired up in apps/web/eslint.config.mjs.

const DATABASE_MODULE = /^(?:@omniralph\/db(?:\/.*)?|@\/lib\/db)$/;
const REVALIDATE = new Set(["revalidatePath", "revalidateTag"]);

/** @type {import("eslint").Rule.RuleModule} */
export const noServerData = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow server actions, revalidation and database imports in the signed-in pages: read and write through /api/ui",
    },
    schema: [],
    messages: {
      useServer:
        'Pages under (app) have no server actions: add a route handler under src/app/api/ui and call it with useApiMutation, not "use server".',
      revalidate:
        "Pages under (app) aren't revalidated: a mutation invalidates the queries it affects (useApiMutation's invalidate), not {{name}}.",
      database:
        "Pages under (app) read no data on the server: load it in an /api/ui route handler and query it with TanStack Query, not by importing {{source}}.",
    },
  },
  create(context) {
    const checkDirectives = (body) => {
      for (const statement of body) {
        if (statement.type !== "ExpressionStatement" || typeof statement.directive !== "string")
          return;
        if (statement.directive === "use server") {
          context.report({ node: statement, messageId: "useServer" });
        }
      }
    };
    const checkSource = (node) => {
      const source = node.source;
      if (!source || source.type !== "Literal" || typeof source.value !== "string") return;
      if (DATABASE_MODULE.test(source.value)) {
        context.report({ node, messageId: "database", data: { source: source.value } });
      }
    };
    return {
      Program(node) {
        checkDirectives(node.body);
      },
      // An inline server action: `async function save() { "use server"; … }`.
      "FunctionDeclaration, FunctionExpression, ArrowFunctionExpression"(node) {
        if (node.body.type === "BlockStatement") checkDirectives(node.body.body);
      },
      ImportDeclaration(node) {
        checkSource(node);
        if (node.source.value !== "next/cache") return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier" && REVALIDATE.has(specifier.imported.name)) {
            context.report({
              node: specifier,
              messageId: "revalidate",
              data: { name: specifier.imported.name },
            });
          }
        }
      },
      ExportNamedDeclaration: checkSource,
      ExportAllDeclaration: checkSource,
      ImportExpression(node) {
        checkSource(node);
      },
      CallExpression(node) {
        // `revalidatePath(…)`, also through a namespace (`cache.revalidatePath(…)`).
        const callee = node.callee;
        const name =
          callee.type === "Identifier"
            ? callee.name
            : callee.type === "MemberExpression" && callee.property.type === "Identifier"
              ? callee.property.name
              : null;
        if (name !== null && REVALIDATE.has(name)) {
          context.report({ node, messageId: "revalidate", data: { name } });
        }
      },
    };
  },
};

const plugin = {
  meta: { name: "data-path" },
  rules: { "no-server-data": noServerData },
};

export default plugin;
