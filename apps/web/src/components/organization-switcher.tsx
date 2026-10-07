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
          style={
            collapsed
              ? { margin: "0 auto" }
              : { width: "100%", justifyContent: "flex-start", gap: "var(--space-2)" }
          }
        >
          <IconBuilding size={16} style={{ color: "var(--glacier-300)", flexShrink: 0 }} />
          {!collapsed && (
            <>
              <span
                style={{
                  flex: 1,
                  textAlign: "left",
                  fontSize: "var(--text-sm)",
                  color: "var(--text-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {active.name}
              </span>
              <IconSelector size={14} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" style={{ minWidth: 220 }}>
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {organizations.map((organization) => (
          <DropdownMenuItem key={organization.id} onSelect={() => select(organization)}>
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {organization.name}
            </span>
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
