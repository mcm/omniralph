"use client";

import { Button, Menu, type MenuItem } from "@omniralph/ui";
import { IconBuilding, IconPlus, IconSelector } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import * as React from "react";
import { api } from "@/lib/api/client";
import { mutationResultSchema } from "@/lib/api/schemas";
import { ONBOARDING_PATH } from "@/lib/auth/routes";
import { useCurrentUser } from "./current-user";
import { useExpectOrganizationSwitch } from "./organization-guard";
import { useApiMutation } from "./use-api-mutation";

export const ALL_ORGANIZATIONS_LABEL = "All organizations";

/** A picker choice: every organization the user belongs to, or one of them. */
type Choice = { kind: "all" } | { kind: "single"; id: string; name: string };

function choiceKey(choice: Choice): string {
  return choice.kind === "all" ? "all" : choice.id;
}

/**
 * Picks this device's organization scope: one of the user's organizations, or "All
 * organizations" (only offered with two or more). Reads everything from `useCurrentUser()`,
 * so it fits any slot (the sidebar, the phone drawer). A pick applies without a reload:
 * the shell re-renders in the new scope, with a fresh query cache.
 */
export function OrganizationPicker() {
  const router = useRouter();
  const client = useQueryClient();
  const { organization, organizations, scope } = useCurrentUser();
  const expectSwitch = useExpectOrganizationSwitch();
  const rendered: Choice =
    scope === "all"
      ? { kind: "all" }
      : { kind: "single", id: organization.id, name: organization.name };
  // The choice just made, shown until the shell re-renders with it (or another one).
  const [picked, setPicked] = React.useState<{ choice: Choice; over: string } | null>(null);
  const current = picked?.over === choiceKey(rendered) ? picked.choice : rendered;

  const switchTo = useApiMutation({
    // Not scoped to the active organization: any of the user's may become the active one.
    mutationFn: async (choice: Choice) => {
      const result = await api.post("/api/ui/organizations/switch", mutationResultSchema, {
        body: choice.kind === "all" ? { scope: "all" } : { organizationId: choice.id },
      });
      // The cookies changed: not another tab's switch.
      expectSwitch();
      return result;
    },
    invalidate: () => [],
    success: null,
    onSuccess: (_, choice) => {
      setPicked({ choice, over: choiceKey(rendered) });
      // Stop the previous scope's queries, start over from the dashboard, and re-render
      // the shell in the new scope: `QueryProvider` is keyed by it, so the cache starts empty.
      void client.cancelQueries();
      router.push("/");
      router.refresh();
    },
  });

  const select = (choice: Choice) => {
    if (choiceKey(choice) === choiceKey(current)) return;
    switchTo.mutate(choice);
  };

  const label = current.kind === "all" ? ALL_ORGANIZATIONS_LABEL : current.name;
  const items: MenuItem[] = [
    ...(organizations.length >= 2
      ? [
          {
            label: ALL_ORGANIZATIONS_LABEL,
            checked: current.kind === "all",
            onSelect: () => select({ kind: "all" }),
          },
        ]
      : []),
    ...organizations.map((option) => ({
      label: option.name,
      checked: current.kind === "single" && current.id === option.id,
      onSelect: () => select({ kind: "single", id: option.id, name: option.name }),
    })),
    "separator",
    { label: "New organization", icon: IconPlus, onSelect: () => router.push(ONBOARDING_PATH) },
  ];

  return (
    <Menu
      align="start"
      disabled={switchTo.isPending}
      items={items}
      trigger={
        <Button
          variant="ghost"
          icon={IconBuilding}
          className="or-org-picker"
          aria-label={`Organization: ${label}`}
        >
          <span className="or-org-picker__label or-rail-hidden">{label}</span>
          <IconSelector
            className="or-org-picker__chevron or-rail-hidden"
            size={14}
            stroke={1.75}
            aria-hidden="true"
          />
        </Button>
      }
    />
  );
}
