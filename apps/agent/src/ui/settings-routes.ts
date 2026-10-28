/**
 * `PUT /api/settings/{section}`: the agent page saves one section of
 * `settings.json` against the revision it read. The body is validated by the
 * section's shared schema and written through `LocalSettingsStore`, whose
 * `change` publishes the `settings` event (`publishLocalChanges`).
 */
import {
  LOCAL_SETTINGS_SECTIONS,
  LOCAL_SETTINGS_SECTION_BODIES,
  type LocalSettingsSection,
  type LocalSettingsSectionBodies,
} from "@omniralph/shared";
import { settingsIssues, type LocalSettingsStore } from "../settings.js";
import { UiHttpError, type UiRoute } from "./server.js";

/** The 409's message: the file changed since the page read it. */
export const SETTINGS_CONFLICT_MESSAGE =
  "These settings changed on the machine. Review and save again.";

/** The 400's message: the body (or the settings it would make) isn't valid. */
export const SETTINGS_INVALID_MESSAGE = "These settings aren't valid.";

const SECTION_PATH = new RegExp(`^/api/settings/(${LOCAL_SETTINGS_SECTIONS.join("|")})$`);

/**
 * Answers the new `LocalSettingsState` (settings, effective, revision,
 * lastError); a stale revision 409 `{ error, settings }` with the current
 * state; an invalid body 400 `{ error, issues }`.
 */
export function settingsRoutes(store: Pick<LocalSettingsStore, "update">): UiRoute[] {
  return [
    {
      method: "PUT",
      path: SECTION_PATH,
      handle: async ({ params, json }) => {
        const section = params[0] as LocalSettingsSection;
        const parsed = LOCAL_SETTINGS_SECTION_BODIES[section].safeParse(await json());
        if (!parsed.success) {
          throw new UiHttpError(400, SETTINGS_INVALID_MESSAGE, settingsIssues(parsed.error.issues));
        }
        const { revision, ...body } = parsed.data as LocalSettingsSectionBodies[typeof section];
        const result = await store.update(section, body, revision);
        switch (result.status) {
          case "saved":
            return { status: 200, body: result.state };
          case "conflict":
            return {
              status: 409,
              body: { error: SETTINGS_CONFLICT_MESSAGE, settings: result.state },
            };
          case "invalid":
            throw new UiHttpError(400, SETTINGS_INVALID_MESSAGE, result.issues);
        }
      },
    },
  ];
}
