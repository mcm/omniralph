import { INSTALL_JOB_TYPE, InstallPayload } from "@omniralph/shared";
import type { PackageManager } from "../packages/manager.js";
import type { SystemRpc } from "./index.js";

export interface InstallRpcOptions {
  /** The agent's package manager, shared with the agent page (one queue, one history). */
  packages: PackageManager;
}

/**
 * `install` (targeted at one agent by an admin from Fleet) installs or
 * updates an installable through the agent's `PackageManager`: the local
 * allow-list in force is checked before npm runs, whatever the control panel
 * allowed; an invalid manifest is rolled back; installs run one at a time
 * with the page's; each is recorded in the install history as `fleet`.
 */
export function installRpc({ packages }: InstallRpcOptions): SystemRpc {
  return {
    name: INSTALL_JOB_TYPE,
    run(job, ctx) {
      const payload = InstallPayload.safeParse(job.payload);
      if (!payload.success) return Promise.reject(new Error("invalid install payload"));
      try {
        return packages.install({
          ...payload.data,
          from: "fleet",
          signal: ctx.signal,
          logger: ctx.logger,
        }).done;
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
