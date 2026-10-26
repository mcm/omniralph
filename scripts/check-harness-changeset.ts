// The changeset check's old path, kept so CI runs on branches that still call it keep working
// during the 2.0 freeze: it runs scripts/check-agent-changeset.ts with the same arguments and
// exit code. Epic 14 deletes this file.
//
// Usage: tsx scripts/check-harness-changeset.ts <base-ref>
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./check-agent-changeset.js";

export { main };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
