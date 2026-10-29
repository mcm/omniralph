/**
 * The agent page's packages API: the installed installables, local
 * installs, updates and removals through the agent's `PackageManager` (the
 * same queue, allow-list and manifest check as Fleet's `install` RPC), and
 * the install history with npm's output. Each install's progress reaches the
 * page as `packages` events (`publishLocalChanges`); the allow-list is saved
 * with `PUT /api/settings/allow-list` (`settingsRoutes`).
 */
import { InstallPayload } from "@omniralph/shared";
import { InstallablePackageName } from "@omniralph/tasks";
import type { Logger } from "../logger.js";
import type { InstallHistory } from "../packages/history.js";
import {
  PackageNotAllowedError,
  PackageNotInstalledError,
  type PackageManager,
} from "../packages/manager.js";
import { settingsIssues } from "../settings.js";
import { UiHttpError, type UiRoute } from "./server.js";

/** The 400's message for an install body that isn't valid. */
export const PACKAGE_INVALID_MESSAGE = "Enter a package name and a version or tag.";

const InstallBody = InstallPayload.strict();

export function packageRoutes(options: {
  packages: Pick<PackageManager, "installed" | "install" | "remove">;
  history: Pick<InstallHistory, "list" | "get">;
  logger: Logger;
}): UiRoute[] {
  const { packages, history, logger } = options;
  /** The request runs on after the answer; its outcome is in the history. */
  const background = (done: Promise<unknown>) =>
    void done.catch((error: unknown) =>
      logger.debug({ err: error }, "a package request from the agent page failed"),
    );
  return [
    {
      method: "GET",
      path: "/api/packages",
      handle: async () => ({ status: 200, body: { packages: await packages.installed() } }),
    },
    {
      method: "POST",
      path: "/api/packages",
      handle: async ({ json }) => {
        const parsed = InstallBody.safeParse(await json());
        if (!parsed.success) {
          throw new UiHttpError(400, PACKAGE_INVALID_MESSAGE, settingsIssues(parsed.error.issues));
        }
        try {
          const { record, done } = packages.install({ ...parsed.data, from: "local" });
          background(done);
          return { status: 202, body: record };
        } catch (error) {
          if (error instanceof PackageNotAllowedError) {
            throw new UiHttpError(403, error.message);
          }
          throw error;
        }
      },
    },
    {
      method: "GET",
      path: "/api/packages/history",
      handle: () => ({ status: 200, body: { installs: history.list() } }),
    },
    {
      method: "GET",
      path: /^\/api\/packages\/history\/([^/]+)$/,
      handle: ({ params }) => {
        const record = history.get(params[0]!);
        if (!record) throw new UiHttpError(404, "Not found");
        return { status: 200, body: record };
      },
    },
    {
      method: "DELETE",
      path: /^\/api\/packages\/(.+)$/,
      handle: async ({ params }) => {
        const name = InstallablePackageName.safeParse(params[0]);
        if (!name.success) throw new UiHttpError(404, "Not found");
        try {
          const { record, done } = await packages.remove({ name: name.data, from: "local" });
          background(done);
          return { status: 202, body: record };
        } catch (error) {
          if (error instanceof PackageNotInstalledError) {
            throw new UiHttpError(404, error.message);
          }
          throw error;
        }
      },
    },
  ];
}
