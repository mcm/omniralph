// Shared by the global setup (Vitest's main process) and the test-side helpers.

declare module "vitest" {
  interface ProvidedContext {
    /** The test run's Postgres (its admin database), or undefined without Docker. */
    testPostgresUri: string | undefined;
  }
}

/** The migrated database every test database is cloned from. */
export const TEMPLATE_DATABASE = "omniralph_template";

/** `uri` with its database replaced by `name`. */
export const withDatabase = (uri: string, name: string) => uri.replace(/\/[^/]*$/, `/${name}`);
