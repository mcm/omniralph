/**
 * Timing of the Discord Gateway cron (`/api/cron/discord-gateway`). Ordinary
 * messages only arrive over the Gateway WebSocket, which a serverless function
 * can only hold open while it runs. Each run listens for
 * `DISCORD_GATEWAY_LISTEN_SECONDS`; the cron (`vercel.json`, every
 * `DISCORD_GATEWAY_CRON_MINUTES`) starts the next one before that ends, so the
 * listeners overlap and no message falls into a gap. Events both listeners
 * forward during the overlap are deduplicated by Chat SDK (message IDs in the
 * state adapter). The function's `maxDuration` leaves room for the Gateway
 * login and for forwarding the last events after the listening time ends.
 */
export const DISCORD_GATEWAY_CRON_MINUTES = 9;
export const DISCORD_GATEWAY_LISTEN_SECONDS = 10 * 60;
export const DISCORD_GATEWAY_MAX_DURATION_SECONDS = 800;

/** The cron schedule `vercel.json` must declare for the Gateway route. */
export const DISCORD_GATEWAY_CRON_SCHEDULE = `*/${DISCORD_GATEWAY_CRON_MINUTES} * * * *`;
