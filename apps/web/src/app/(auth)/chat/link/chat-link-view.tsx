"use client";

import * as React from "react";
import { Button, Card, EmptyState } from "@omniralph/ui";
import { IconLinkOff } from "@tabler/icons-react";
import type { ChatPlatform } from "@omniralph/db";
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
      <div className="or-card auth-card">
        <EmptyState
          title="Can't link this chat account"
          headingLevel={1}
          icon={IconLinkOff}
          description={<span role="alert">{problem}</span>}
          action={<Button href="/">Back to the control panel</Button>}
        />
      </div>
    );
  }

  const platform = PLATFORM_NAMES[confirmation.platform];
  return (
    <Card
      title={linked ? `${platform} account linked` : `Link ${platform} account`}
      headingLevel={1}
      className="auth-card"
    >
      <div className="auth-stack">
        {linked ? (
          <p className="auth-lede">
            {platform} user <strong>{confirmation.displayName}</strong> is linked to your account in{" "}
            {confirmation.organizationName}.
          </p>
        ) : (
          <>
            <p className="auth-lede">
              Link {platform} user <strong>{confirmation.displayName}</strong> to your account in{" "}
              <strong>{confirmation.organizationName}</strong>?
            </p>
            <p className="auth-lede">
              Om will act as you for this {platform} user in {confirmation.connectionName}. Only
              link an account that is yours.
            </p>
          </>
        )}
        <div className="auth-actions">
          {linked ? (
            <Button href={CHAT_ACCOUNTS_PATH} variant="solid">
              Chat accounts
            </Button>
          ) : (
            <>
              <Button href="/">Cancel</Button>
              <Button
                variant="solid"
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
        </div>
      </div>
    </Card>
  );
}
