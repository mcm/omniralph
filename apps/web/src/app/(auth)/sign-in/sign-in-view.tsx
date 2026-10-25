"use client";

import * as React from "react";
import { Button, Card, Field, TextInput } from "@omniralph/ui";
import { IconBrandGithub, IconBrandGitlab, type TablerIcon } from "@tabler/icons-react";
import { AuthAlert } from "@/components/auth-shell";
import { Link } from "@/components/link";
import { signInWithProvider } from "@/lib/auth/actions";
import { signInDescription } from "@/lib/auth/sign-in-copy";
import { DEV_SIGN_IN_PATH, PRIVACY_PATH, TERMS_PATH } from "@/lib/auth/routes";

type ProviderId = "github" | "gitlab";

const providerIcons: Record<ProviderId, TablerIcon> = {
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
    <Card title="Sign in" headingLevel={1} className="auth-card">
      <div className="auth-stack">
        <p className="auth-lede">
          {signInDescription(
            providers.map((p) => p.name),
            devSignIn,
          )}
        </p>
        {error && <AuthAlert title="Couldn't sign you in">{errorMessage(error)}</AuthAlert>}
        {providers.length === 0 && !devSignIn && (
          <AuthAlert title="No sign-in providers configured">
            Set AUTH_GITHUB_ID/AUTH_GITHUB_SECRET or AUTH_GITLAB_ID/AUTH_GITLAB_SECRET.
          </AuthAlert>
        )}
        {providers.map(({ id, name }) => (
          <Button
            key={id}
            variant="solid"
            icon={providerIcons[id]}
            disabled={pending !== null}
            onClick={() => signIn(id)}
            className="auth-wide"
          >
            {pending === id ? `Redirecting to ${name}…` : `Continue with ${name}`}
          </Button>
        ))}
        {devSignIn && (
          <form action={DEV_SIGN_IN_PATH} method="get" className="auth-stack">
            <input type="hidden" name="callbackUrl" value={callbackUrl} />
            <Field
              label="Dev sign-in"
              htmlFor="dev-sign-in-email"
              description="Development only (OMNIRALPH_DEV_SIGNIN=1): signs in as an existing user, e.g. admin@fixtures.example."
              stacked
            >
              <TextInput name="email" type="email" required />
            </Field>
            <Button type="submit" className="auth-wide">
              Sign in by email
            </Button>
          </form>
        )}
        <p className="auth-fine-print">
          By signing in, you agree to the{" "}
          <Link href={TERMS_PATH} className="inline-link">
            terms of service
          </Link>{" "}
          and the{" "}
          <Link href={PRIVACY_PATH} className="inline-link">
            privacy policy
          </Link>
          .
        </p>
      </div>
    </Card>
  );
}
