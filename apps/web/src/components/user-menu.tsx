"use client";

import { Menu, ThemeControl } from "@omniralph/ui";
import { IconHelp, IconLogout } from "@tabler/icons-react";
import * as React from "react";
import { signOutAction } from "@/lib/auth/actions";
import { useKeyShortcuts } from "@/lib/shortcuts";
import { userDisplayName } from "@/lib/user-display";
import { HELP_PATH } from "./app-shortcuts";
import { useCurrentUser } from "./current-user";

/**
 * The signed-in user's menu: who they are, the theme, "Help" (the Help page, `/help`) and
 * "Sign out". It opens from `trigger`, so the sidebar footer and the phone avatar open the
 * same menu. The theme
 * comes from the shell's `ThemeProvider`, which applies and saves a choice.
 */
export function UserMenu({ trigger }: { trigger: React.ReactElement }) {
  const user = useCurrentUser();
  const [signingOut, startSignOut] = React.useTransition();
  const name = userDisplayName(user);
  const helpKeys = useKeyShortcuts("help");
  return (
    <Menu
      trigger={trigger}
      header={
        <>
          <div className="or-menu__heading">
            <span className="or-menu__heading-title">{name}</span>
            {user.email && user.email !== name && (
              <span className="or-menu__heading-detail">{user.email}</span>
            )}
          </div>
          <ThemeControl />
        </>
      }
      items={[
        { label: "Help", icon: IconHelp, href: HELP_PATH, keyShortcuts: helpKeys },
        {
          label: "Sign out",
          icon: IconLogout,
          disabled: signingOut,
          onSelect: () => startSignOut(() => signOutAction()),
        },
      ]}
    />
  );
}
