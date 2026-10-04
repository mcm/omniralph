"use client";

import * as React from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iamthemcmaster/ui";
import { IconAlertTriangle, IconBrandGithub, IconBrandGitlab } from "@tabler/icons-react";
import { AuthBrand } from "@/components/auth-shell";
import { signInWithProvider } from "@/lib/auth/actions";

type ProviderId = "github" | "gitlab";

const providerIcons: Record<ProviderId, React.ElementType> = {
  github: IconBrandGithub,
  gitlab: IconBrandGitlab,
};

/** Auth.js error codes shown on the sign-in page. */
function errorMessage(code: string): string {
  switch (code) {
    case "OAuthAccountNotLinked":
      return "This email is already linked to another provider. Sign in with the provider you used before.";
    case "Configuration":
      return "Sign-in is misconfigured. Ask an admin to check the server's auth settings.";
    default:
      return "Sign-in failed. Please try again.";
  }
}

interface SignInViewProps {
  providers: { id: ProviderId; name: string }[];
  callbackUrl: string;
  error: string | null;
}

export function SignInView({ providers, callbackUrl, error }: SignInViewProps) {
  const [pending, setPending] = React.useState<ProviderId | null>(null);
  const [, startTransition] = React.useTransition();

  const signIn = (id: ProviderId) => {
    setPending(id);
    startTransition(() => signInWithProvider(id, callbackUrl));
  };

  return (
    <>
      <AuthBrand />
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            Use your GitHub or GitLab account. Access is limited to approved team members.
          </CardDescription>
        </CardHeader>
        <CardContent style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {error && (
            <Alert variant="destructive">
              <IconAlertTriangle size={16} />
              <AlertTitle>Couldn&apos;t sign you in</AlertTitle>
              <AlertDescription>{errorMessage(error)}</AlertDescription>
            </Alert>
          )}
          {providers.length === 0 && (
            <Alert variant="warning">
              <IconAlertTriangle size={16} />
              <AlertTitle>No sign-in providers configured</AlertTitle>
              <AlertDescription>
                Set AUTH_GITHUB_ID/AUTH_GITHUB_SECRET or AUTH_GITLAB_ID/AUTH_GITLAB_SECRET.
              </AlertDescription>
            </Alert>
          )}
          {providers.map(({ id, name }) => {
            const Icon = providerIcons[id];
            return (
              <Button
                key={id}
                variant="secondary"
                disabled={pending !== null}
                onClick={() => signIn(id)}
                style={{ width: "100%", gap: "var(--space-2)" }}
              >
                <Icon size={16} />
                {pending === id ? `Redirecting to ${name}…` : `Continue with ${name}`}
              </Button>
            );
          })}
        </CardContent>
      </Card>
    </>
  );
}
