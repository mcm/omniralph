/**
 * Public base URL of the control panel (no trailing slash): `APP_URL`, else Vercel's
 * production domain. Code hosts call back to it (webhooks), so it must be reachable
 * from GitHub/GitLab.
 */
export function getAppUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url =
    env.APP_URL ??
    (env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`
      : undefined);
  if (!url) throw new Error("APP_URL is not set");
  return url.replace(/\/+$/, "");
}

/** Endpoint GitLab project webhooks deliver to. */
export function gitlabWebhookUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${getAppUrl(env)}/api/webhooks/gitlab`;
}
