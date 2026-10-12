"use client";

import { useRouter } from "next/navigation";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@iamthemcmaster/ui";
import { IconBuilding, IconCheck, IconPlus, IconSelector } from "@tabler/icons-react";
import { ONBOARDING_PATH } from "@/lib/auth/routes";
import { switchOrganization } from "@/lib/organizations/actions";
import { useCurrentUser } from "./current-user";
import { useAction } from "./use-action";

export interface OrganizationOption {
  id: string;
  name: string;
}

/** Shows the active organization and switches between the user's organizations. */
export function OrganizationSwitcher({
  organizations,
  collapsed,
}: {
  organizations: OrganizationOption[];
  collapsed: boolean;
}) {
  const router = useRouter();
  const { organization: active } = useCurrentUser();
  const { pending, run } = useAction();

  const select = (organization: OrganizationOption) => {
    if (organization.id === active.id) return;
    run(
      () => switchOrganization(organization.id),
      `Switched to ${organization.name}`,
      () => {
        // Pages show the previous organization's data; start over from the dashboard.
        router.push("/");
        router.refresh();
      },
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={collapsed ? "icon" : "sm"}
          disabled={pending}
          aria-label={`Organization: ${active.name}. Switch organization`}
          title={collapsed ? active.name : undefined}
          className={collapsed ? "mx-auto" : "org-switcher-trigger"}
        >
          <IconBuilding size={16} className="shrink-0 text-text-accent" />
          {!collapsed && (
            <>
              <span className="flex-1 truncate text-left text-sm text-text-primary">
                {active.name}
              </span>
              <IconSelector size={14} className="shrink-0 text-text-tertiary" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="org-switcher-menu">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {organizations.map((organization) => (
          <DropdownMenuItem key={organization.id} onSelect={() => select(organization)}>
            <span className="flex-1 truncate">{organization.name}</span>
            {organization.id === active.id && <IconCheck size={14} aria-label="Active" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push(ONBOARDING_PATH)}>
          <IconPlus size={14} />
          New organization
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
