"use client";

import { Button, EmptyState } from "@omniralph/ui";
import { IconLock } from "@tabler/icons-react";

interface AccessDeniedViewProps {
  /** `not-allowed`: the account may not sign in; `forbidden`: signed in, but not an admin. */
  reason: "not-allowed" | "forbidden";
}

export function AccessDeniedView({ reason }: AccessDeniedViewProps) {
  const forbidden = reason === "forbidden";
  return (
    <div className="or-card auth-card">
      <EmptyState
        title="Access denied"
        headingLevel={1}
        icon={IconLock}
        description={
          <>
            <span role="alert" className="auth-denied-reason">
              {forbidden
                ? "This page is only available to admins."
                : "Your account isn't allowed to use this control panel."}
            </span>{" "}
            {forbidden
              ? "Ask an admin of your organization to change your role if you need access."
              : "Sign-in is limited to approved email domains and people invited to an organization. Ask an organization admin to invite your email, then try again."}
          </>
        }
        action={
          forbidden ? (
            <Button href="/">Back to the control panel</Button>
          ) : (
            <Button href="/sign-in" variant="solid">
              Try another account
            </Button>
          )
        }
      />
    </div>
  );
}
