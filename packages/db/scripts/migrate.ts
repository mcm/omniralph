// `pnpm --filter db migrate`: applies migrations to DATABASE_URL. Neon's direct
// (unpooled) URL is preferred when the integration injects one. Empty values count as unset
// (`vercel pull` writes sensitive variables as empty strings).
import { runMigrations } from "../src/migrate.js";

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

await runMigrations(url);
console.log("Migrations applied");
