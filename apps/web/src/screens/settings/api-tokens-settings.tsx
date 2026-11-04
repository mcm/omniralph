"use client";

import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Field,
  IconButton,
  TextInput,
  toast,
  type DataTableColumn,
} from "@omniralph/ui";
import { IconCopy, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { z } from "zod";
import { useCurrentUser } from "@/components/current-user";
import { useApiMutation } from "@/components/use-api-mutation";
import {
  API_TOKEN_NAME_MAX_LENGTH,
  createdApiTokenSchema,
  type ApiTokenList,
  type ApiTokenRow,
  type CreatedApiToken,
} from "@/lib/api/api-tokens";
import { api } from "@/lib/api/client";
import { formatDate } from "@/lib/format-date";
import { apiTokensKey, useApiTokens } from "./queries";

export const CREATE_TOKEN = "Create token";
export const COPY_TOKEN = "Copy token";

/** What a token is for, under the card's title. */
export function apiTokensDescription(organization: string): string {
  return `A token lets a tool such as the PRD plugin save PRFAQs and Plans in ${organization} as you. Treat it like a password.`;
}

/** What revoking a token causes. */
export function revokeDescription(token: ApiTokenRow): string {
  return `Tools using ${token.prefix}… stop working at once. This can't be undone.`;
}

/** "Never", or the day the token was last used. */
export function lastUsed(token: ApiTokenRow): string {
  return token.lastUsedAt ? formatDate(token.lastUsedAt) : "Never";
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Token copied");
  } catch {
    toast("Couldn't copy to the clipboard", { variant: "danger" });
  }
}

function columns(onRevoke: (token: ApiTokenRow) => void): DataTableColumn<ApiTokenRow>[] {
  return [
    { id: "name", header: "Name", card: "title", cell: (token) => token.name },
    {
      id: "token",
      header: "Token",
      cell: (token) => <code>{token.prefix}…</code>,
    },
    { id: "created", header: "Created", cell: (token) => formatDate(token.createdAt) },
    { id: "used", header: "Last used", cell: lastUsed },
    {
      id: "actions",
      header: <span className="or-sr-only">Actions</span>,
      card: "status",
      align: "end",
      cell: (token) => (
        <IconButton
          label={`Revoke ${token.name}`}
          icon={IconTrash}
          variant="ghost"
          onClick={() => onRevoke(token)}
        />
      ),
    },
  ];
}

/**
 * You › API tokens: the signed-in member's personal tokens for the active organization. A
 * name and "Create token" show the new token once, with Copy; the list shows each token's
 * prefix and when it was created and last used, and Revoke (after a `ConfirmDialog`) removes
 * it at once, put back with an error toast if the server refuses.
 */
export function ApiTokensSettings() {
  const { organization } = useCurrentUser();
  const query = useApiTokens();
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  // The token the dialog asks about; kept while the dialog closes.
  const [target, setTarget] = useState<ApiTokenRow | null>(null);
  const [confirming, setConfirming] = useState(false);

  const create = useApiMutation<CreatedApiToken, { name: string }>({
    mutationFn: (body, { organizationId }) =>
      api.post("/api/ui/api-tokens", createdApiTokenSchema, { body, organizationId }),
    applyResult: ({ apiToken }, cache) =>
      cache.set<ApiTokenList>(
        apiTokensKey(cache.keys),
        (previous) =>
          previous && {
            tokens: [apiToken, ...previous.tokens.filter((entry) => entry.id !== apiToken.id)],
          },
        { exact: true },
      ),
    invalidate: (keys) => [apiTokensKey(keys)],
    success: "Token created",
    onSuccess: (result) => {
      setCreated(result);
      setName("");
      setNameError(null);
    },
    onError: (error) => setNameError(error.fieldErrors?.name ?? null),
  });

  const revoke = useApiMutation<{ ok: true }, ApiTokenRow>({
    mutationFn: (token, { organizationId }) =>
      api.delete(
        `/api/ui/api-tokens/${encodeURIComponent(token.id)}`,
        z.object({ ok: z.literal(true) }),
        { organizationId },
      ),
    optimistic: (token, cache) =>
      cache.set<ApiTokenList>(
        apiTokensKey(cache.keys),
        (previous) =>
          previous && { tokens: previous.tokens.filter((entry) => entry.id !== token.id) },
        { exact: true },
      ),
    invalidate: (keys) => [apiTokensKey(keys)],
    success: "Token revoked",
    onSuccess: (_, token) => {
      if (created?.apiToken.id === token.id) setCreated(null);
    },
  });

  const submit = () => {
    if (create.isPending) return;
    if (!name.trim()) {
      setNameError("Name the token.");
      return;
    }
    create.mutate({ name: name.trim() });
  };

  return (
    <>
      <Card title="API tokens" titleId="api-tokens">
        <div className="or-api-tokens">
          <p className="or-api-tokens__note">{apiTokensDescription(organization.name)}</p>
          <form
            className="or-api-tokens__create"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Field
              label="Name"
              description={nameError ?? "Where you'll use it, e.g. “PRD plugin on my laptop”."}
              stacked
            >
              <TextInput
                value={name}
                maxLength={API_TOKEN_NAME_MAX_LENGTH}
                aria-invalid={nameError ? true : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(null);
                }}
              />
            </Field>
            <div>
              <Button type="submit" variant="solid" disabled={create.isPending}>
                {CREATE_TOKEN}
              </Button>
            </div>
          </form>

          {created ? (
            <section className="or-api-tokens__created" aria-label="New token">
              <div className="or-api-tokens__value">
                <TextInput
                  mono
                  readOnly
                  aria-label={`Token ${created.apiToken.name}`}
                  value={created.token}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <IconButton
                  label={COPY_TOKEN}
                  icon={IconCopy}
                  variant="outline"
                  onClick={() => void copy(created.token)}
                />
              </div>
              <p className="or-api-tokens__note">
                Copy it now: it isn&apos;t shown again. Set it as <code>OMNIRALPH_API_TOKEN</code>{" "}
                where the tool runs.
              </p>
            </section>
          ) : null}
        </div>
      </Card>

      {query.isPending ? (
        <p aria-busy="true">Loading…</p>
      ) : query.isError ? (
        <EmptyState
          title="Couldn't load your API tokens"
          description={query.error.message}
          action={
            <Button variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        />
      ) : query.data.tokens.length === 0 ? (
        <EmptyState title="No API tokens" description="Tokens you create show here." />
      ) : (
        <DataTable
          caption="Your API tokens"
          rows={query.data.tokens}
          getRowId={(token) => token.id}
          columns={columns((token) => {
            setTarget(token);
            setConfirming(true);
          })}
        />
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={target ? `Revoke ${target.name}?` : ""}
        description={target ? revokeDescription(target) : ""}
        confirmLabel="Revoke"
        destructive
        onConfirm={() => {
          if (target) revoke.mutate(target);
        }}
      />
    </>
  );
}
