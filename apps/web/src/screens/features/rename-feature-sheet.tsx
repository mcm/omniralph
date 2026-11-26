"use client";

import { Button, Field, Sheet, TextInput } from "@omniralph/ui";
import { useState, type FormEvent } from "react";
import { FEATURE_NAME_MAX_LENGTH, type FeatureRow } from "@/lib/api/features";
import { useRenameFeature } from "./mutations";
import { FEATURE_NAME_EXPLANATION } from "./new-feature-sheet";

export const RENAME_FEATURE = "Rename";

export interface RenameFeatureSheetProps {
  feature: FeatureRow;
  onClose: () => void;
}

/**
 * Rename (a `Sheet`, from the feature's header): its Name. Save (`PATCH /api/ui/features/{id}`)
 * renames it and closes; an unchanged name just closes; a refusal shows the server's message
 * and keeps what was typed.
 */
export function RenameFeatureSheet({ feature, onClose }: RenameFeatureSheetProps) {
  const rename = useRenameFeature(feature);
  const [name, setName] = useState(feature.name);
  const [error, setError] = useState<string | null>(null);
  const canSave = name.trim() !== "" && !rename.isPending;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSave) return;
    const next = name.trim();
    if (next === feature.name) {
      onClose();
      return;
    }
    setError(null);
    rename.mutate(next, {
      onSuccess: onClose,
      onError: (failure) => setError(failure.message),
    });
  };

  return (
    <Sheet
      title={`Rename ${feature.name}`}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button variant="solid" disabled={!canSave} onClick={() => submit()}>
            {rename.isPending ? "Saving…" : "Save"}
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <form className="or-new-feature" onSubmit={submit} noValidate>
        {error ? (
          <p className="or-feature__error" role="alert">
            {error}
          </p>
        ) : null}
        <Field label="Name" description={FEATURE_NAME_EXPLANATION} stacked>
          <TextInput
            value={name}
            required
            maxLength={FEATURE_NAME_MAX_LENGTH}
            invalid={error !== null || undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      </form>
    </Sheet>
  );
}
