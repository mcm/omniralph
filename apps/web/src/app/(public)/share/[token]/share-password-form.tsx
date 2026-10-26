"use client";

import { Button, Card, Field, TextInput } from "@omniralph/ui";
import { IconLock } from "@tabler/icons-react";
import * as React from "react";

/** A protected review link's password step: the right password reloads the page, open. */
export function SharePasswordForm({ token }: { token: string }) {
  const [password, setPassword] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/share/${encodeURIComponent(token)}/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (response.ok || response.status === 404) {
        window.location.reload();
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Something went wrong. Try again.");
    } catch {
      setError("Something went wrong. Try again.");
    }
    setPending(false);
  };

  return (
    <Card title="This review link has a password" headingLevel={1} className="auth-card">
      <form onSubmit={submit} className="auth-stack">
        {error ? (
          <div role="alert" className="auth-alert">
            <span className="or-dot or-dot--fail" aria-hidden="true" />
            <div className="auth-alert-body">
              <p className="auth-alert-text">{error}</p>
            </div>
          </div>
        ) : null}
        <Field label="Password" htmlFor="share-password" stacked>
          <TextInput
            type="password"
            autoComplete="current-password"
            required
            maxLength={200}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="solid" icon={IconLock} disabled={pending || !password}>
          {pending ? "Opening…" : "Open"}
        </Button>
      </form>
    </Card>
  );
}
