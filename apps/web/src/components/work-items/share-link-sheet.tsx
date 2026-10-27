"use client";

import { Button, Field, IconButton, Sheet, TextInput, toast } from "@omniralph/ui";
import { IconCopy, IconLock } from "@tabler/icons-react";
import { useState } from "react";
import type { CreateShareLinkResponse } from "@/lib/api/work-items";
import { formatShareExpiry } from "@/lib/work-items/share-expiry";
import {
  useCreateShareLink,
  useRevokeShareLink,
  useShareLinks,
  type ShareLinkTarget,
} from "./use-share-links";
import "./share-link-sheet.css";

export const SHARE_REVIEW_LINK_TITLE = "Share review link";
export const CREATE_LINK = "Create link";
export const COPY_LINK = "Copy link";
export const PROTECTED_LINK = "Password protected";

/** "Expires Nov 23". */
export function expiresOn(expiresAt: string): string {
  return `Expires ${formatShareExpiry(expiresAt)}`;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Link copied");
  } catch {
    toast("Couldn't copy to the clipboard", { variant: "danger" });
  }
}

export interface ShareLinkSheetProps {
  item: ShareLinkTarget & { identifier: string };
  onClose: () => void;
}

/**
 * Share review link (a `Sheet`): an optional password and "Create link", then the new link
 * (shown once) with Copy and its expiry; under it the item's active links, each with its
 * expiry, a lock when protected, and Revoke (removed at once, back on failure). The list is
 * live: a `work_item` event naming the item refetches it.
 */
export function ShareLinkSheet({ item, onClose }: ShareLinkSheetProps) {
  const links = useShareLinks(item);
  const create = useCreateShareLink(item);
  const revoke = useRevokeShareLink(item);
  const [password, setPassword] = useState("");
  const [created, setCreated] = useState<CreateShareLinkResponse | null>(null);

  const submit = () => {
    if (create.isPending) return;
    create.mutate(
      { password },
      {
        onSuccess: (result) => {
          setCreated(result);
          setPassword("");
        },
      },
    );
  };

  const active = links.data?.links ?? [];

  return (
    <Sheet
      title={SHARE_REVIEW_LINK_TITLE}
      description={`A public page with the PRD and stories of ${item.identifier}. Anyone with the link can open it.`}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="or-wi-share">
        <form
          className="or-wi-share__create"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field
            label="Password (optional)"
            description="Viewers type it before the page opens."
            stacked
          >
            <TextInput
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <div>
            <Button type="submit" variant="solid" disabled={create.isPending}>
              {CREATE_LINK}
            </Button>
          </div>
        </form>

        {created ? (
          <section className="or-wi-share__created" aria-label="New review link">
            <div className="or-wi-share__url">
              <TextInput
                mono
                readOnly
                aria-label="Review link"
                value={created.url}
                onFocus={(event) => event.currentTarget.select()}
              />
              <IconButton
                label={COPY_LINK}
                icon={IconCopy}
                variant="outline"
                onClick={() => void copy(created.url)}
              />
            </div>
            <p className="or-wi-share__note">
              {expiresOn(created.link.expiresAt)}. Copy it now: it isn&apos;t shown again.
            </p>
          </section>
        ) : null}

        <section className="or-wi-share__links" aria-labelledby="or-wi-share-active">
          <h3 id="or-wi-share-active" className="or-wi-share__heading">
            Active links
          </h3>
          {links.isPending ? (
            <p className="or-wi-share__note">Loading links…</p>
          ) : links.isError ? (
            <p className="or-wi-share__note" role="alert">
              Couldn&apos;t load the links. {links.error.message}{" "}
              <Button size="sm" variant="outline" onClick={() => void links.refetch()}>
                Retry
              </Button>
            </p>
          ) : active.length === 0 ? (
            <p className="or-wi-share__note">No active links.</p>
          ) : (
            <ul className="or-wi-share__list">
              {active.map((link) => (
                <li key={link.id} className="or-wi-share__link">
                  {link.protected ? (
                    <IconLock
                      className="or-wi-share__lock"
                      size={14}
                      role="img"
                      aria-label={PROTECTED_LINK}
                    />
                  ) : null}
                  <span className="or-wi-share__expiry">{expiresOn(link.expiresAt)}</span>
                  {link.createdBy ? (
                    <span className="or-wi-share__by">by {link.createdBy.name}</span>
                  ) : null}
                  <Button size="sm" variant="outline" onClick={() => revoke.mutate(link)}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Sheet>
  );
}
