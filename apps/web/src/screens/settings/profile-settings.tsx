"use client";

import { Card, Switch, ThemeControl } from "@omniralph/ui";
import { useId } from "react";
import { useCurrentUser } from "@/components/current-user";
import { useShowAdvanced } from "@/components/show-advanced";
import { userDisplayName, userInitials } from "@/lib/user-display";

/** What the "Show advanced settings" switch does. */
export const SHOW_ADVANCED_DESCRIPTION =
  "Shows Routing rules, Playbooks and Chat channel overrides in Settings.";

/** The user's avatar, name and email, as their sign-in provider gave them (read-only). */
function ProfileCard() {
  const user = useCurrentUser();
  const name = userDisplayName(user);
  return (
    <Card title="Profile" titleId="profile">
      <div className="or-profile">
        <span className="or-avatar or-profile__avatar" aria-hidden="true">
          {user.image ? (
            // The sign-in provider's picture, any host: as the shell's avatar renders it.
            // eslint-disable-next-line @next/next/no-img-element
            <img className="or-avatar__img" src={user.image} alt="" />
          ) : (
            userInitials(user)
          )}
        </span>
        <dl className="or-profile__facts">
          <dt className="or-sr-only">Name</dt>
          <dd className="or-profile__name">{name}</dd>
          {user.email && (
            <>
              <dt className="or-sr-only">Email</dt>
              <dd className="or-profile__email">{user.email}</dd>
            </>
          )}
        </dl>
      </div>
    </Card>
  );
}

/**
 * The theme (the same `ThemeControl` the user menu shows, bound to the shell's
 * `ThemeProvider`, which applies and saves a choice) and "Show advanced settings", the
 * preference's only control: it shows or hides Settings' Advanced group and nothing else.
 */
function DisplayCard() {
  const [showAdvanced, setShowAdvanced] = useShowAdvanced();
  const id = useId();
  const advancedId = `${id}-advanced`;
  return (
    <Card title="Display" titleId="display">
      <div className="or-field">
        <div className="or-field__head">
          <span className="or-field__label">Theme</span>
        </div>
        <div className="or-field__control">
          <ThemeControl size="md" />
        </div>
      </div>
      <div className="or-field">
        <div className="or-field__head">
          <label id={`${advancedId}-label`} htmlFor={advancedId} className="or-field__label">
            Show advanced settings
          </label>
          <p id={`${advancedId}-description`} className="or-field__description">
            {SHOW_ADVANCED_DESCRIPTION}
          </p>
        </div>
        <div className="or-field__control">
          <Switch
            id={advancedId}
            aria-labelledby={`${advancedId}-label`}
            aria-describedby={`${advancedId}-description`}
            checked={showAdvanced}
            onCheckedChange={setShowAdvanced}
          />
        </div>
      </div>
    </Card>
  );
}

/** You › Profile & theme: who the user is and how the panel looks to them. Every member's own. */
export function ProfileSettings() {
  return (
    <>
      <ProfileCard />
      <DisplayCard />
    </>
  );
}
