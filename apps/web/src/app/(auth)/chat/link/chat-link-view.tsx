"use client";

import Link from "next/link";
import * as React from "react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@iamthemcmaster/ui";
import { IconLink } from "@tabler/icons-react";
import type { ChatPlatform } from "@omniralph/db";
import { AuthBrand } from "@/components/auth-shell";
import { useServerAction } from "../../use-server-action";
import { CHAT_ACCOUNTS_PATH } from "@/lib/chat/link-paths";
import { linkChatAccountAction } from "./actions";

const PLATFORM_NAMES: Record<ChatPlatform, string> = { slack: "Slack", discord: "Discord" };

interface ChatLinkViewProps {
  /** Why the link can't be used. */
  problem?: string;
  confirmation?: {
    state: string;
    platform: ChatPlatform;
    displayName: string;
    organizationName: string;
    connectionName: string;
  };
}

export function ChatLinkView({ problem, confirmation }: ChatLinkViewProps) {
  const { pending, run } = useServerAction();
  const [linked, setLinked] = React.useState(false);

  if (!confirmation) {
    return (
      <>
        <AuthBrand />
        <Card>
          <CardHeader>
            <CardTitle as="h1">Can&apos;t link this chat account</CardTitle>
            <CardDescription>{problem}</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button asChild variant="secondary">
              <Link href="/">Back to the control panel</Link>
            </Button>
          </CardFooter>
        </Card>
      </>
    );
  }

  const platform = PLATFORM_NAMES[confirmation.platform];
  return (
    <>
      <AuthBrand />
      <Card>
        <CardHeader>
          <div className="auth-title-row">
            <IconLink size={18} />
            <CardTitle as="h1">
              {linked ? `${platform} account linked` : `Link ${platform} account`}
            </CardTitle>
          </div>
          <CardDescription>
            {linked ? (
              <>
                {platform} user <strong>{confirmation.displayName}</strong> is linked to your
                account in {confirmation.organizationName}. You can unlink it in Settings › Chat
                accounts.
              </>
            ) : (
              <>
                Link {platform} user <strong>{confirmation.displayName}</strong> to your account in{" "}
                <strong>{confirmation.organizationName}</strong>?
              </>
            )}
          </CardDescription>
        </CardHeader>
        {!linked && (
          <CardContent className="text-sm text-text-secondary">
            The bot in {confirmation.connectionName} will act as you for this {platform} user. Only
            link an account that is yours.
          </CardContent>
        )}
        <CardFooter>
          {linked ? (
            <Button asChild variant="primary">
              <Link href={CHAT_ACCOUNTS_PATH}>Chat accounts</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="secondary">
                <Link href="/">Cancel</Link>
              </Button>
              <Button
                variant="primary"
                disabled={pending}
                onClick={() =>
                  run(
                    () => linkChatAccountAction(confirmation.state),
                    `Linked ${confirmation.displayName}`,
                    () => setLinked(true),
                  )
                }
              >
                Link
              </Button>
            </>
          )}
        </CardFooter>
      </Card>
    </>
  );
}
