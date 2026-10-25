"use client";

import { Menu, ThemeControl } from "@omniralph/ui";
import { IconLogout } from "@tabler/icons-react";
import * as React from "react";
import { signOutAction } from "@/lib/auth/actions";
import { userDisplayName } from "@/lib/user-display";
import { useCurrentUser } from "./current-user";

/**
 * The signed-in user's menu: who they are, the theme and "Sign out". It opens from
 * `trigger`, so the sidebar footer and the phone avatar open the same menu. The theme
 * comes from the shell's `ThemeProvider`, which applies and saves a choice.
 */
export function UserMenu({ trigger }: { trigger: React.ReactElement }) {
  const user = useCurrentUser();
  const [signingOut, startSignOut] = React.useTransition();
  const name = userDisplayName(user);
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
