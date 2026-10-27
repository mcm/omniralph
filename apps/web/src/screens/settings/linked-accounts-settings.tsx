"use client";

import {
  BRAND_NAMES,
  BrandMark,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  IconButton,
  OrgBadge,
  type DataTableColumn,
} from "@omniralph/ui";
import { IconUnlink } from "@tabler/icons-react";
import { useState } from "react";
import { useApiMutation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import type { ChatAccount, ChatAccounts, UnlinkChatAccountInput } from "@/lib/api/organization";
import { mutationResultSchema } from "@/lib/api/schemas";
import { chatAccountsKey, useChatAccounts } from "./queries";

/** The chat username shown for a linked account: its display name, else its chat user ID. */
export function chatUsername(account: ChatAccount): string {
  return account.displayName ?? account.externalUserId;
}

/** The Slack workspace or Discord server of a linked account, else the platform's name. */
export function chatWorkspace(account: ChatAccount): string {
  return account.workspace ?? BRAND_NAMES[account.platform];
}

/** What unlinking a linked account causes. */
export function unlinkDescription(account: ChatAccount): string {
  return `Om won't recognize your messages from ${chatWorkspace(account)} until you link it again.`;
}

function accountId(account: ChatAccount): string {
  return `${account.organizationId}:${account.platform}:${account.externalUserId}`;
}

function sameAccount(a: ChatAccount, b: UnlinkChatAccountInput): boolean {
  return (
    a.organizationId === b.organizationId &&
    a.platform === b.platform &&
    a.externalUserId === b.externalUserId
  );
}

function columns(onUnlink: (account: ChatAccount) => void): DataTableColumn<ChatAccount>[] {
  return [
    {
      id: "account",
      header: "Account",
      card: "title",
      cell: (account) => (
        <span className="or-linked-account">
          <BrandMark brand={account.platform} />
          <span>{chatUsername(account)}</span>
        </span>
      ),
    },
    { id: "workspace", header: "Workspace", cell: chatWorkspace },
    {
      id: "organization",
      header: "Organization",
      cell: (account) => <OrgBadge name={account.organizationName} />,
    },
    {
      id: "actions",
      header: <span className="or-sr-only">Actions</span>,
      card: "status",
      align: "end",
      cell: (account) => (
        <IconButton
          label={`Unlink ${chatUsername(account)}`}
          icon={IconUnlink}
          variant="ghost"
          onClick={() => onUnlink(account)}
        />
      ),
    },
  ];
}

/**
 * You › Linked chat accounts: the Slack and Discord accounts linked to the signed-in user,
 * in every organization. Unlinking (after a `ConfirmDialog`) removes the row at once, put
 * back with an error toast if the server refuses; a link made elsewhere (`/chat/link` in
 * another tab, the bot's automatic link by email) arrives live.
 */
export function LinkedAccountsSettings() {
  const query = useChatAccounts();
  // The account the dialog asks about; kept while the dialog closes.
  const [target, setTarget] = useState<ChatAccount | null>(null);
  const [confirming, setConfirming] = useState(false);
  const unlink = useApiMutation({
    mutationFn: (input: UnlinkChatAccountInput, { organizationId }) =>
      api.post("/api/ui/chat-accounts/unlink", mutationResultSchema, {
        body: input,
        organizationId,
      }),
    optimistic: (input, cache) =>
      cache.set<ChatAccounts>(
        chatAccountsKey(cache.keys),
        (previous) =>
          previous && {
            identities: previous.identities.filter((account) => !sameAccount(account, input)),
          },
        { exact: true },
      ),
    invalidate: (keys) => [keys.chatAccounts.all],
    success: null,
  });

  if (query.isPending) return <p aria-busy="true">Loading…</p>;
  if (query.isError) {
    return (
      <EmptyState
        title="Couldn't load your linked chat accounts"
        description={query.error.message}
        action={
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  const accounts = query.data.identities;
  return (
    <>
      {accounts.length === 0 ? (
        <EmptyState
          title="No linked chat accounts"
          description="Mention Om in Slack or Discord and follow the link it sends you."
        />
      ) : (
        <DataTable
          caption="Linked chat accounts"
          rows={accounts}
          getRowId={accountId}
          columns={columns((account) => {
            setTarget(account);
            setConfirming(true);
          })}
        />
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={target ? `Unlink ${chatUsername(target)}?` : ""}
        description={target ? unlinkDescription(target) : ""}
        confirmLabel="Unlink"
        destructive
        onConfirm={() => {
          if (!target) return;
          unlink.mutate({
            organizationId: target.organizationId,
            platform: target.platform,
            externalUserId: target.externalUserId,
          });
        }}
      />
    </>
  );
}
