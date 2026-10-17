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
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { mutationResultSchema } from "@/lib/api/schemas";
import { ONBOARDING_PATH } from "@/lib/auth/routes";
import { useCurrentUser } from "./current-user";
import { useExpectOrganizationSwitch } from "./organization-guard";
import { useApiMutation } from "./use-api-mutation";

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
  const client = useQueryClient();
  const { organization: active } = useCurrentUser();
  const expectSwitch = useExpectOrganizationSwitch();
  const switchTo = useApiMutation({
    // Not scoped to the active organization: any of the user's may become the active one.
    mutationFn: async (organization: OrganizationOption) => {
      const result = await api.post("/api/ui/organizations/switch", mutationResultSchema, {
        body: { organizationId: organization.id },
      });
      // The cookie changed: not another tab's switch.
      expectSwitch();
      return result;
    },
    invalidate: () => [],
    success: (_, organization) => `Switched to ${organization.name}`,
    onSuccess: () => {
      // Stop the previous organization's queries (they'd be refused now), start over from
      // the dashboard, and re-render the shell in the new organization: `QueryProvider`
      // then drops the previous organization's cache and every page loads the new one's.
      void client.cancelQueries();
      router.push("/");
      router.refresh();
    },
  });
  const pending = switchTo.isPending;

  const select = (organization: OrganizationOption) => {
    if (organization.id === active.id) return;
    switchTo.mutate(organization);
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
      {/* The picker sits at the foot of the sidebar: open upward, or beside it when collapsed. */}
      <DropdownMenuContent
        side={collapsed ? "right" : "top"}
        align={collapsed ? "end" : "start"}
        className="org-switcher-menu"
      >
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
