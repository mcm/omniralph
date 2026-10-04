import { readFileSync } from "node:fs";

/** The agent's version, from its package.json (one level above both `src/` and `dist/`). */
export const AGENT_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
