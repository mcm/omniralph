"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Cluster,
  Muted,
  Skeleton,
  Stack,
} from "@iamthemcmaster/ui";
import { IconUnlink } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { Timestamp } from "@/components/list-table";
import { PageHeader } from "@/components/page-header";
import { QueryBoundary } from "@/components/query-boundary";
import { useQueryKeys } from "@/components/query-provider";
import { useApiMutation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import {
  chatAccountsSchema,
  type ChatAccount,
  type UnlinkChatAccountInput,
} from "@/lib/api/organization";
import { mutationResultSchema } from "@/lib/api/schemas";

const PLATFORM_NAMES: Record<ChatAccount["platform"], string> = {
  slack: "Slack",
  discord: "Discord",
};

export type { ChatAccount };

/** The signed-in user's linked chat accounts, live (`GET /api/ui/chat-accounts`). */
export function useChatAccounts() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.chatAccounts.list(),
    queryFn: ({ signal }) =>
      api.get("/api/ui/chat-accounts", chatAccountsSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

function AccountsSkeleton() {
  return (
    <>
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center justify-between gap-3">
          <Stack gap={1} className="flex-1">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-72" />
          </Stack>
          <Skeleton className="h-9 w-24" />
        </div>
      ))}
    </>
  );
}

export function ChatAccountsView() {
  const query = useChatAccounts();

  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Chat accounts" }]} />
      <main className="detail-main">
        <PageHeader
          title="Chat accounts"
          description="Slack and Discord accounts linked to you. The Omniralph bot answers a linked account as you, with your access in that organization."
        />
        <Card>
          <CardHeader>
            <CardTitle as="h2">Linked accounts</CardTitle>
            <CardDescription>
              To link an account, mention the Omniralph bot in Slack or Discord and follow the link
              it sends you. A Slack account with your sign-in email is linked automatically.
            </CardDescription>
          </CardHeader>
          <Stack gap={3} asChild>
            <CardContent>
              <QueryBoundary
                query={query}
                skeleton={<AccountsSkeleton />}
                what="your chat accounts"
              >
                {({ identities }) => (
                  <>
                    {identities.length === 0 && <Muted>No chat accounts are linked to you.</Muted>}
                    {identities.map((identity) => (
                      <LinkedAccount
                        key={`${identity.organizationId}:${identity.platform}:${identity.externalUserId}`}
                        identity={identity}
                      />
                    ))}
                  </>
                )}
              </QueryBoundary>
            </CardContent>
          </Stack>
        </Card>
      </main>
    </>
  );
}

function LinkedAccount({ identity }: { identity: ChatAccount }) {
  const platform = PLATFORM_NAMES[identity.platform];
  const name = identity.displayName ?? identity.externalUserId;
  const unlink = useApiMutation({
    mutationFn: (input: UnlinkChatAccountInput, { organizationId }) =>
      api.post("/api/ui/chat-accounts/unlink", mutationResultSchema, {
        body: input,
        organizationId,
      }),
    invalidate: (keys) => [keys.chatAccounts.all],
    success: `Unlinked ${name}`,
  });
  // Stays disabled until the refetch drops the row.
  const pending = unlink.isPending || unlink.isSuccess;
  return (
    <Cluster gap={3} justify="between">
      <div>
        <Cluster>
          <strong>{name}</strong>
          <Badge variant="neutral" size="sm">
            {platform}
          </Badge>
        </Cluster>
        <Muted>
          {identity.organizationName} · linked{" "}
          {identity.source === "email" ? "automatically by email " : ""}
          <Timestamp iso={identity.linkedAt} inline />
        </Muted>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="danger" disabled={pending}>
            <IconUnlink size={14} />
            Unlink
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The bot stops answering this {platform} account as you in {identity.organizationName},
              and won&apos;t link it automatically again. You can link it again through the bot.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              onClick={() =>
                unlink.mutate({
                  organizationId: identity.organizationId,
                  platform: identity.platform,
                  externalUserId: identity.externalUserId,
                })
              }
            >
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Cluster>
  );
}
