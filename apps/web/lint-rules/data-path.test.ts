import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noServerData } from "./data-path.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
});

ruleTester.run("no-server-data", noServerData, {
  valid: [
    '"use client";\nimport { useQuery } from "@tanstack/react-query";',
    'import { api } from "@/lib/api/client";',
    'import type { RunRow } from "@/lib/api/runs";',
    'import { dbLabel } from "@/lib/dbx";',
    'import { unstable_noStore } from "next/cache";',
    'function f() { "use strict"; return 1; }',
    "router.refresh();",
  ],
  invalid: [
    {
      code: '"use server";\nexport async function save() {}',
      errors: [{ messageId: "useServer" }],
    },
    {
      code: 'export async function save() {\n  "use server";\n}',
      errors: [{ messageId: "useServer" }],
    },
    {
      code: 'const save = async () => {\n  "use server";\n};',
      errors: [{ messageId: "useServer" }],
    },
    {
      code: 'import { revalidatePath } from "next/cache";\nrevalidatePath("/");',
      errors: [{ messageId: "revalidate" }, { messageId: "revalidate" }],
    },
    {
      code: 'import { revalidateTag as tag } from "next/cache";',
      errors: [{ messageId: "revalidate" }],
    },
    {
      code: 'import * as cache from "next/cache";\ncache.revalidateTag("runs");',
      errors: [{ messageId: "revalidate" }],
    },
    { code: 'import { listRuns } from "@omniralph/db";', errors: [{ messageId: "database" }] },
    { code: 'import type { Database } from "@omniralph/db";', errors: [{ messageId: "database" }] },
    {
      code: 'import { createTestDatabase } from "@omniralph/db/testing";',
      errors: [{ messageId: "database" }],
    },
    { code: 'import { getDb } from "@/lib/db";', errors: [{ messageId: "database" }] },
    { code: 'export { getDb } from "@/lib/db";', errors: [{ messageId: "database" }] },
    { code: 'export * from "@omniralph/db";', errors: [{ messageId: "database" }] },
    { code: 'const db = await import("@omniralph/db");', errors: [{ messageId: "database" }] },
  ],
});
