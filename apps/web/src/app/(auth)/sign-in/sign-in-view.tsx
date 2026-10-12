"use client";

import * as React from "react";
import Link from "next/link";
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
  Field,
  Input,
} from "@iamthemcmaster/ui";
import { IconAlertTriangle, IconBrandGithub, IconBrandGitlab } from "@tabler/icons-react";
import { AuthBrand } from "@/components/auth-shell";
import { signInWithProvider } from "@/lib/auth/actions";
import { DEV_SIGN_IN_PATH, PRIVACY_PATH, TERMS_PATH } from "@/lib/auth/routes";

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
  /** Show the dev-only sign-in by email (`devSignInEnabled()`). */
  devSignIn: boolean;
}

export function SignInView({ providers, callbackUrl, error, devSignIn }: SignInViewProps) {
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
          {providers.length === 0 && !devSignIn && (
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
          {devSignIn && (
            <form
              action={DEV_SIGN_IN_PATH}
              method="get"
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
            >
              <input type="hidden" name="callbackUrl" value={callbackUrl} />
              <Field
                label="Dev sign-in"
                htmlFor="dev-sign-in-email"
                hint="Development only (OMNIRALPH_DEV_SIGNIN=1): signs in as an existing user, e.g. admin@fixtures.example."
              >
                <Input id="dev-sign-in-email" name="email" type="email" required />
              </Field>
              <Button type="submit" variant="secondary" style={{ width: "100%" }}>
                Sign in by email
              </Button>
            </form>
          )}
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
              textAlign: "center",
            }}
          >
            By signing in, you agree to the{" "}
            <Link href={TERMS_PATH} style={{ color: "inherit" }}>
              terms of service
            </Link>{" "}
            and the{" "}
            <Link href={PRIVACY_PATH} style={{ color: "inherit" }}>
              privacy policy
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </>
  );
}
