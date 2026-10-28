/**
 * `POST /api/update`: "Update now" from the agent page. It hands the request to
 * `SelfUpdater.request()` (the one entry point, which `omniralph-agent update`
 * reaches too) and heartbeats at once, so the drain starts within seconds
 * instead of at the next interval. The updater's `change` publishes the
 * `update` event (`publishLocalChanges`).
 */
import { AgentVersion } from "@omniralph/shared";
import { z } from "zod";
import { settingsIssues } from "../settings.js";
import type { SelfUpdater } from "../update.js";
import { UiHttpError, type UiRoute } from "./server.js";

/** The 409's message: not under pm2, so the agent never installs anything itself. */
export const UPDATE_UNSUPPORTED_MESSAGE = "This agent can't update itself";

/** The body: `{}` for the pin, else the organization's, else the latest; or one version. */
const UpdateNowBody = z.strictObject({ version: AgentVersion.nullable().optional() });

/** Answers 202 with the pending request; 409 when not under pm2; 400 for an invalid body. */
export function updateRoutes(options: {
  updater: Pick<SelfUpdater, "support" | "request">;
  daemon: { heartbeatSoon(): void };
}): UiRoute[] {
  return [
    {
      method: "POST",
      path: "/api/update",
      handle: async ({ json }) => {
        const parsed = UpdateNowBody.safeParse(await json());
        if (!parsed.success) {
          throw new UiHttpError(
            400,
            "This update isn't valid.",
            settingsIssues(parsed.error.issues),
          );
        }
        if (options.updater.support !== "supported") {
          throw new UiHttpError(409, UPDATE_UNSUPPORTED_MESSAGE);
        }
        const request = options.updater.request({ version: parsed.data.version ?? null });
        options.daemon.heartbeatSoon();
        return { status: 202, body: { request } };
      },
    },
  ];
}
