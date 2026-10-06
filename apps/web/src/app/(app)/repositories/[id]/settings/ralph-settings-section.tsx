"use client";

import * as React from "react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Label,
  Muted,
  Switch,
} from "@iamthemcmaster/ui";
import { IconDeviceFloppy } from "@tabler/icons-react";
import {
  fieldErrors as toFieldErrors,
  MAX_SETUP_COMMAND_LENGTH,
  parseCommaList,
  RalphSettingsInput,
  type FieldErrors,
} from "@omniralph/shared";
import { useAction } from "@/components/use-action";
import { updateRalphSettings } from "./actions";

export interface RalphSettingsValues {
  ralphEnabled: boolean;
  linearTeamKeys: string[];
  linearProjectNames: string[];
  linearLabels: string[];
  openPullRequestEarly: boolean;
  setupCommand: string;
  model: string;
  manualLabels: string[];
}

const stack: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

/** The first error of a list field (`linearLabels` or `linearLabels.2`). */
function listError(errors: FieldErrors, field: string): string | undefined {
  return errors[field] ?? Object.entries(errors).find(([key]) => key.startsWith(`${field}.`))?.[1];
}

function Toggle({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)" }}>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
        <Label htmlFor={id}>{label}</Label>
        <Muted>{description}</Muted>
      </div>
    </div>
  );
}

/**
 * Repository › Settings › Ralph (admin-only): opts the repository into
 * Linear-driven builds, says which Linear issues route to it and how its runs work.
 */
export function RalphSettingsSection({
  repositoryId,
  settings,
}: {
  repositoryId: string;
  settings: RalphSettingsValues;
}) {
  const { pending, run } = useAction();
  const [ralphEnabled, setRalphEnabled] = React.useState(settings.ralphEnabled);
  const [teamKeys, setTeamKeys] = React.useState(settings.linearTeamKeys.join(", "));
  const [projectNames, setProjectNames] = React.useState(settings.linearProjectNames.join(", "));
  const [labels, setLabels] = React.useState(settings.linearLabels.join(", "));
  const [openPullRequestEarly, setOpenPullRequestEarly] = React.useState(
    settings.openPullRequestEarly,
  );
  const [setupCommand, setSetupCommand] = React.useState(settings.setupCommand);
  const [model, setModel] = React.useState(settings.model);
  const [manualLabels, setManualLabels] = React.useState(settings.manualLabels.join(", "));
  const [errors, setErrors] = React.useState<FieldErrors>({});

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = RalphSettingsInput.safeParse({
      ralphEnabled,
      linearTeamKeys: parseCommaList(teamKeys),
      linearProjectNames: parseCommaList(projectNames),
      linearLabels: parseCommaList(labels),
      openPullRequestEarly,
      setupCommand,
      model,
      manualLabels: parseCommaList(manualLabels),
    } satisfies RalphSettingsInput);
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      return;
    }
    run(
      () => updateRalphSettings(repositoryId, parsed.data),
      "Ralph settings saved; they apply to new runs",
      () => setErrors({}),
      (result) => setErrors(result.fieldErrors ?? {}),
    );
  };

  const routingInput = (
    id: string,
    label: string,
    hint: string,
    field: keyof RalphSettingsValues,
    value: string,
    onChange: (value: string) => void,
    placeholder: string,
  ) => {
    const error = listError(errors, field);
    return (
      <Field label={label} htmlFor={id} hint={hint} error={error}>
        <Input
          id={id}
          disabled={pending}
          error={Boolean(error)}
          aria-invalid={Boolean(error)}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      </Field>
    );
  };

  return (
    <form onSubmit={save} noValidate style={{ display: "contents" }}>
      <Card>
        <CardHeader>
          <CardTitle>Ralph</CardTitle>
          <CardDescription>
            Let Linear issues delegated to the Omniralph app be built here, story by story. A
            delegation goes to the first enabled repository that matches its{" "}
            <code>[repo=&lt;path&gt;]</code> tag, then its labels, project and team.
          </CardDescription>
        </CardHeader>
        <CardContent style={stack}>
          <Toggle
            id="ralph-enabled"
            label="Enable ralph"
            description="Delegated Linear issues may build in this repository and push branches to it."
            checked={ralphEnabled}
            disabled={pending}
            onChange={setRalphEnabled}
          />
          {routingInput(
            "ralph-labels",
            "Linear labels",
            "Comma-separated. Issues with any of these labels route here.",
            "linearLabels",
            labels,
            setLabels,
            "backend, api",
          )}
          {routingInput(
            "ralph-projects",
            "Linear projects",
            "Comma-separated project names.",
            "linearProjectNames",
            projectNames,
            setProjectNames,
            "Omniralph",
          )}
          {routingInput(
            "ralph-teams",
            "Linear team keys",
            "Comma-separated, e.g. ENG.",
            "linearTeamKeys",
            teamKeys,
            setTeamKeys,
            "ENG, OPS",
          )}
          <Toggle
            id="ralph-open-pr-early"
            label="Open the pull request early (openPullRequestEarly)"
            description="Open a draft pull or merge request after the first story is pushed, and mark it ready when the run finishes."
            checked={openPullRequestEarly}
            disabled={pending}
            onChange={setOpenPullRequestEarly}
          />
          {routingInput(
            "ralph-manual-labels",
            "Manual labels",
            "Comma-separated. Stories with any of these labels are steps for a person: ralph skips them and waits until they're done. The first one labels the manual stories and follow-ups ralph files.",
            "manualLabels",
            manualLabels,
            setManualLabels,
            "manual",
          )}
          <Field
            label="Setup command"
            htmlFor="ralph-setup-command"
            hint={`Runs once in a new branch worktree, e.g. to install dependencies. At most ${MAX_SETUP_COMMAND_LENGTH.toLocaleString()} characters.`}
            error={errors.setupCommand}
          >
            <Input
              id="ralph-setup-command"
              disabled={pending}
              error={Boolean(errors.setupCommand)}
              aria-invalid={Boolean(errors.setupCommand)}
              value={setupCommand}
              onChange={(e) => setSetupCommand(e.target.value)}
              placeholder="pnpm install --frozen-lockfile"
              style={{ fontFamily: "var(--font-mono)" }}
            />
          </Field>
          <Field
            label="Model"
            htmlFor="ralph-model"
            hint="Claude model alias or ID the story sessions use."
            error={errors.model}
            required
          >
            <Input
              id="ralph-model"
              disabled={pending}
              error={Boolean(errors.model)}
              aria-invalid={Boolean(errors.model)}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              style={{ fontFamily: "var(--font-mono)" }}
            />
          </Field>
          <div>
            <Button type="submit" variant="primary" disabled={pending}>
              <IconDeviceFloppy size={14} />
              {pending ? "Saving…" : "Save Ralph settings"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
