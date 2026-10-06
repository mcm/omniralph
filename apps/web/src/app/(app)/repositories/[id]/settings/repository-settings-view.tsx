"use client";

import * as React from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Label,
  Muted,
  RadioGroup,
  RadioGroupItem,
  Switch,
  Textarea,
} from "@iamthemcmaster/ui";
import { IconAdjustments, IconDeviceFloppy, IconExternalLink } from "@tabler/icons-react";
import {
  fieldErrors as toFieldErrors,
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  parsePathExcludes,
  RepositorySettingsInput,
  type FieldErrors,
} from "@omniralph/shared";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { useAction } from "@/components/use-action";
import { ProviderIcon } from "../../repositories-view";
import { RepositoryNav } from "../repository-nav";
import { ProfileFacts, type ProfileSummary } from "../../../settings/profiles/profile-facts";
import { updateRepositorySettings } from "./actions";
import { RalphSettingsSection, type RalphSettingsValues } from "./ralph-settings-section";

interface RepositorySettingsViewProps {
  repository: {
    id: string;
    provider: "github" | "gitlab";
    fullPath: string;
    webUrl: string;
  };
  settings: {
    profileId: string;
    triggers: { onOpen: boolean; onPush: boolean; drafts: boolean };
    pathExcludes: string[];
    customInstructions: string;
    pinnedAgentIds: string[];
  };
  profiles: ProfileSummary[];
  /** Agents that can be pinned (not revoked). */
  agents: { id: string; name: string; /** ISO timestamp. */ lastHeartbeatAt: string | null }[];
  /** The Ralph section's settings; only passed to admins. */
  ralph: RalphSettingsValues | null;
}

const stack: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const errorText: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--error)",
};

function InlineError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" style={errorText}>
      {message}
    </p>
  );
}

/** Errors of the path-exclude lines, as "Line n: …" (lines count blank ones too). */
function pathExcludeErrors(text: string, errors: FieldErrors): string[] {
  const lineNumbers: number[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim()) lineNumbers.push(index + 1);
  });
  return Object.entries(errors).flatMap(([key, message]) => {
    const match = /^pathExcludes\.(\d+)$/.exec(key);
    if (!match) return key === "pathExcludes" ? [message] : [];
    const line = lineNumbers[Number(match[1])];
    return [`Line ${line ?? Number(match[1]) + 1}: ${message}`];
  });
}

function TriggerToggle({
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

export function RepositorySettingsView({
  repository,
  settings,
  profiles,
  agents,
  ralph,
}: RepositorySettingsViewProps) {
  const isAdmin = useCurrentUser().role === "admin";
  const { pending, run } = useAction();
  const disabled = !isAdmin || pending;

  const [profileId, setProfileId] = React.useState(settings.profileId);
  const [triggers, setTriggers] = React.useState(settings.triggers);
  const [pathExcludes, setPathExcludes] = React.useState(settings.pathExcludes.join("\n"));
  const [customInstructions, setCustomInstructions] = React.useState(settings.customInstructions);
  const [pinnedAgentIds, setPinnedAgentIds] = React.useState(settings.pinnedAgentIds);
  const [errors, setErrors] = React.useState<FieldErrors>({});

  // Pinned agents that were revoked since are dropped from the selection on save.
  const knownAgentIds = new Set(agents.map((a) => a.id));

  const togglePin = (agentId: string, checked: boolean) =>
    setPinnedAgentIds((ids) => (checked ? [...ids, agentId] : ids.filter((id) => id !== agentId)));

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const input: RepositorySettingsInput = {
      profileId: profileId as RepositorySettingsInput["profileId"],
      triggers,
      pathExcludes: parsePathExcludes(pathExcludes),
      customInstructions,
      pinnedAgentIds: pinnedAgentIds.filter((id) => knownAgentIds.has(id)),
    };
    const parsed = RepositorySettingsInput.safeParse(input);
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      return;
    }
    const newlyPinned = parsed.data.pinnedAgentIds.filter(
      (id) => !settings.pinnedAgentIds.includes(id),
    ).length;
    run(
      () => updateRepositorySettings(repository.id, parsed.data),
      newlyPinned > 0
        ? "Settings saved; newly pinned agents will pre-clone the repository"
        : "Settings saved; they apply to the next review",
      () => setErrors({}),
      (result) => setErrors(result.fieldErrors ?? {}),
    );
  };

  const excludeErrors = pathExcludeErrors(pathExcludes, errors);
  const instructionsLength = customInstructions.length;

  return (
    <>
      <AppHeader
        breadcrumbs={[
          { label: "Repositories", href: "/repositories" },
          { label: repository.fullPath },
          { label: "Settings" },
        ]}
      />
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-6)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-4)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1
              style={{
                margin: 0,
                fontSize: "var(--text-2xl)",
                fontWeight: "var(--font-weight-semibold)",
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
              }}
            >
              <ProviderIcon provider={repository.provider} size={20} />
              <span style={{ fontFamily: "var(--font-mono)" }}>{repository.fullPath}</span>
            </h1>
            <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
              How this repository is reviewed. Changes apply to the next review; queued and running
              reviews keep the settings they started with.
            </Muted>
          </div>
          <Button asChild variant="ghost">
            <a href={repository.webUrl} target="_blank" rel="noreferrer">
              <IconExternalLink size={14} />
              Open on {repository.provider === "github" ? "GitHub" : "GitLab"}
            </a>
          </Button>
        </div>

        <RepositoryNav repositoryId={repository.id} current="settings" />

        <form onSubmit={save} noValidate style={{ display: "contents" }}>
          <Card>
            <CardHeader>
              <CardTitle>Review profile</CardTitle>
              <CardDescription>
                Trade review depth against token usage.
                {isAdmin && (
                  <>
                    {" "}
                    Edit the profiles themselves in{" "}
                    <Link href="/settings/profiles" style={{ color: "var(--text-accent)" }}>
                      Settings › Profiles
                    </Link>
                    .
                  </>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent style={stack}>
              <RadioGroup
                value={profileId}
                onValueChange={setProfileId}
                disabled={disabled}
                aria-label="Review profile"
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "var(--space-3)",
                }}
              >
                {profiles.map((profile) => {
                  const selected = profile.id === profileId;
                  return (
                    <label
                      key={profile.id}
                      htmlFor={`profile-${profile.id}`}
                      style={{
                        display: "flex",
                        gap: "var(--space-3)",
                        alignItems: "flex-start",
                        padding: "var(--space-4)",
                        borderRadius: "var(--radius-md)",
                        border: `1px solid ${selected ? "var(--border-strong)" : "var(--border-subtle)"}`,
                        background: selected ? "var(--bg-raised)" : "transparent",
                        cursor: disabled ? "default" : "pointer",
                      }}
                    >
                      <RadioGroupItem id={`profile-${profile.id}`} value={profile.id} />
                      <div style={{ ...stack, gap: "var(--space-2)", minWidth: 0 }}>
                        <span
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "var(--space-2)",
                            fontWeight: "var(--font-weight-semibold)",
                            color: "var(--text-primary)",
                          }}
                        >
                          <IconAdjustments size={14} />
                          {profile.name}
                        </span>
                        {profile.description && <Muted>{profile.description}</Muted>}
                        <ProfileFacts profile={profile} />
                      </div>
                    </label>
                  );
                })}
              </RadioGroup>
              <InlineError message={errors.profileId} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Triggers</CardTitle>
              <CardDescription>
                When pull and merge requests are reviewed automatically.
              </CardDescription>
            </CardHeader>
            <CardContent style={{ ...stack, gap: "var(--space-4)" }}>
              <TriggerToggle
                id="trigger-on-open"
                label="On open (onOpen)"
                description="Review a pull or merge request when it's opened or marked ready for review."
                checked={triggers.onOpen}
                disabled={disabled}
                onChange={(onOpen) => setTriggers((t) => ({ ...t, onOpen }))}
              />
              <TriggerToggle
                id="trigger-on-push"
                label="On push (onPush)"
                description="Review the new commits when it's pushed to."
                checked={triggers.onPush}
                disabled={disabled}
                onChange={(onPush) => setTriggers((t) => ({ ...t, onPush }))}
              />
              <TriggerToggle
                id="trigger-drafts"
                label="Include drafts (includeDrafts)"
                description="Also review draft pull requests and merge requests."
                checked={triggers.drafts}
                disabled={disabled}
                onChange={(drafts) => setTriggers((t) => ({ ...t, drafts }))}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Files and instructions</CardTitle>
              <CardDescription>
                Skip files that don&apos;t need review, and tell the reviewer about this
                repository&apos;s conventions.
              </CardDescription>
            </CardHeader>
            <CardContent style={{ ...stack, gap: "var(--space-4)" }}>
              <Field
                label="Path excludes"
                htmlFor="path-excludes"
                hint="One glob per line. A pattern without / matches at any depth; a leading / anchors it to the repository root. Lock files, build output and generated files are always skipped."
              >
                <Textarea
                  id="path-excludes"
                  rows={5}
                  disabled={disabled}
                  error={excludeErrors.length > 0}
                  aria-invalid={excludeErrors.length > 0}
                  value={pathExcludes}
                  onChange={(e) => setPathExcludes(e.target.value)}
                  placeholder={"*.snap\n/docs/**\nsrc/**/*.generated.ts"}
                  style={{ fontFamily: "var(--font-mono)" }}
                />
              </Field>
              {excludeErrors.map((message) => (
                <InlineError key={message} message={message} />
              ))}
              <Field
                label="Custom instructions"
                htmlFor="custom-instructions"
                hint={`Added to every review prompt for this repository. ${instructionsLength.toLocaleString()} / ${MAX_CUSTOM_INSTRUCTIONS_LENGTH.toLocaleString()} characters.`}
                error={errors.customInstructions}
              >
                <Textarea
                  id="custom-instructions"
                  rows={6}
                  disabled={disabled}
                  error={Boolean(errors.customInstructions)}
                  aria-invalid={Boolean(errors.customInstructions)}
                  value={customInstructions}
                  onChange={(e) => setCustomInstructions(e.target.value)}
                  placeholder="e.g. We use Result types instead of exceptions; flag thrown errors in src/core."
                />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Agent pinning</CardTitle>
              <CardDescription>
                Only the selected agents run this repository&apos;s jobs. Leave all unselected to
                let any agent run them. Newly pinned agents pre-clone the repository.
              </CardDescription>
            </CardHeader>
            <CardContent style={stack}>
              {agents.length === 0 ? (
                <Muted>No agents are enrolled yet; any agent that enrolls can run reviews.</Muted>
              ) : (
                <div role="group" aria-label="Pinned agents" style={stack}>
                  {agents.map((agent) => (
                    <div
                      key={agent.id}
                      style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
                    >
                      <Checkbox
                        id={`pin-${agent.id}`}
                        checked={pinnedAgentIds.includes(agent.id)}
                        disabled={disabled}
                        onCheckedChange={(checked) => togglePin(agent.id, checked === true)}
                      />
                      <Label htmlFor={`pin-${agent.id}`}>{agent.name}</Label>
                      {!agent.lastHeartbeatAt && <Badge variant="neutral">Never seen</Badge>}
                    </div>
                  ))}
                </div>
              )}
              {pinnedAgentIds.filter((id) => knownAgentIds.has(id)).length === 0 && (
                <Muted>Any agent can run this repository&apos;s jobs.</Muted>
              )}
              <InlineError
                message={
                  errors.pinnedAgentIds ??
                  Object.entries(errors).find(([key]) => key.startsWith("pinnedAgentIds."))?.[1]
                }
              />
            </CardContent>
          </Card>

          {isAdmin ? (
            <div>
              <Button type="submit" variant="primary" disabled={disabled}>
                <IconDeviceFloppy size={14} />
                {pending ? "Saving…" : "Save settings"}
              </Button>
            </div>
          ) : (
            <Muted>Only admins can change repository settings.</Muted>
          )}
        </form>

        {isAdmin && ralph && <RalphSettingsSection repositoryId={repository.id} settings={ralph} />}
      </main>
    </>
  );
}
