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
  Stack,
} from "@iamthemcmaster/ui";
import { IconUnlink } from "@tabler/icons-react";
import type { ChatPlatform } from "@omniralph/db";
import { AppHeader } from "@/components/app-header";
import { Timestamp } from "@/components/list-table";
import { PageHeader } from "@/components/page-header";
import { useAction } from "@/components/use-action";
import { unlinkChatAccount } from "./actions";

const PLATFORM_NAMES: Record<ChatPlatform, string> = { slack: "Slack", discord: "Discord" };

export interface ChatAccount {
  organizationId: string;
  organizationName: string;
  platform: ChatPlatform;
  externalUserId: string;
  displayName: string | null;
  source: "manual" | "email";
  linkedAt: string;
}

export function ChatAccountsView({ identities }: { identities: ChatAccount[] }) {
  const { pending, run } = useAction();

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
              {identities.length === 0 && <Muted>No chat accounts are linked to you.</Muted>}
              {identities.map((identity) => {
                const platform = PLATFORM_NAMES[identity.platform];
                const name = identity.displayName ?? identity.externalUserId;
                return (
                  <Cluster
                    key={`${identity.organizationId}:${identity.platform}:${identity.externalUserId}`}
                    gap={3}
                    justify="between"
                  >
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
                            The bot stops answering this {platform} account as you in{" "}
                            {identity.organizationName}, and won&apos;t link it automatically again.
                            You can link it again through the bot.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            variant="danger"
                            onClick={() =>
                              run(
                                () =>
                                  unlinkChatAccount({
                                    organizationId: identity.organizationId,
                                    platform: identity.platform,
                                    externalUserId: identity.externalUserId,
                                  }),
                                `Unlinked ${name}`,
                              )
                            }
                          >
                            Unlink
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </Cluster>
                );
              })}
            </CardContent>
          </Stack>
        </Card>
      </main>
    </>
  );
}
