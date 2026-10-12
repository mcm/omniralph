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
  Muted,
} from "@iamthemcmaster/ui";
import { IconUnlink } from "@tabler/icons-react";
import type { ChatPlatform } from "@omniralph/db";
import { AppHeader } from "@/components/app-header";
import { useAction } from "@/components/use-action";
import { formatDateTime } from "@/lib/format-date";
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
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-8)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-6)",
        }}
      >
        <div>
          <h1
            style={{
              margin: 0,
              fontSize: "var(--text-2xl)",
              fontWeight: "var(--font-weight-semibold)",
            }}
          >
            Chat accounts
          </h1>
          <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
            Slack and Discord accounts linked to you. The Omniralph bot answers a linked account as
            you, with your access in that organization.
          </Muted>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Linked accounts</CardTitle>
            <CardDescription>
              To link an account, mention the Omniralph bot in Slack or Discord and follow the link
              it sends you. A Slack account with your sign-in email is linked automatically.
            </CardDescription>
          </CardHeader>
          <CardContent style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            {identities.length === 0 && <Muted>No chat accounts are linked to you.</Muted>}
            {identities.map((identity) => {
              const platform = PLATFORM_NAMES[identity.platform];
              const name = identity.displayName ?? identity.externalUserId;
              return (
                <div
                  key={`${identity.organizationId}:${identity.platform}:${identity.externalUserId}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "var(--space-3)",
                  }}
                >
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                      <strong>{name}</strong>
                      <Badge variant="neutral" size="sm">
                        {platform}
                      </Badge>
                    </div>
                    <Muted style={{ display: "block" }}>
                      {identity.organizationName} · linked{" "}
                      {identity.source === "email" ? "automatically by email " : ""}
                      {formatDateTime(identity.linkedAt)}
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
                </div>
              );
            })}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
