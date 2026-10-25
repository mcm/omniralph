"use client";

import * as React from "react";
import { Link } from "@/components/link";
import { useParams } from "next/navigation";
import { Badge, Button, Field, Muted, Skeleton, Stack, Textarea } from "@iamthemcmaster/ui";
import { IconExternalLink, IconX } from "@tabler/icons-react";
import {
  fieldErrors as toFieldErrors,
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  RepositorySettingsInput,
  RepositoryTaskTypesInput,
  type FieldErrors,
  type ReviewDepth,
} from "@omniralph/shared";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { Freshness } from "@/components/freshness";
import { MonoPath } from "@/components/mono-value";
import { MultiSelect } from "@/components/pickers";
import { PageHeader } from "@/components/page-header";
import { QueryBoundary } from "@/components/query-boundary";
import { useNow } from "@/components/relative-time";
import { SwitchField } from "@/components/settings-card";
import { SettingsSection, SettingsSubsection } from "@/components/settings-section";
import { useApiAction } from "@/components/use-api-action";
import { useSeededDraft } from "@/components/use-seeded-draft";
import { api } from "@/lib/api/client";
import type { RepositoryDetail } from "@/lib/api/repositories";
import { mutationResultSchema } from "@/lib/api/schemas";
import { isHarnessOnline } from "@/lib/harnesses/display";
import {
  formatSettingValue,
  settingChanges,
  withDefault,
  withoutFieldErrors,
} from "@/lib/settings/changes";
import {
  pickKeys,
  REPOSITORY_SECTIONS,
  REPOSITORY_SETTING_DEFAULTS,
  repositoryDraft,
  repositoryInput,
  repositorySpecs,
  repositoryValues,
  type RepositoryDraft,
  type RepositoryValues,
} from "@/lib/settings/forms";
import { HARNESS_UPDATE_STATUS_VARIANTS, stateLabel } from "@/lib/state-variants";
import { HarnessStatusBadge } from "../../../harnesses/harness-parts";
import { ProviderIcon } from "@/components/provider-icon";
import { RepositoryNav } from "../repository-nav";
import { repositoryChanged, useRepositoryDetail } from "../repository-queries";
import {
  saveWithTaskTypes,
  TaskTypeSelect,
  taskTypeOn,
  taskTypeSpec,
  type TaskTypeSwitch,
  type TaskTypesValues,
} from "./task-types";

/** The repository's settings tabs, by route segment. */
export type RepositorySettingsTab = "settings" | "harnesses";

const TAB_LABELS: Record<RepositorySettingsTab, string> = {
  settings: "Review settings",
  harnesses: "Harnesses",
};

interface RepositorySettingsContentProps {
  tab: RepositorySettingsTab;
  repository: RepositoryDetail["repository"];
  settings: {
    depth: ReviewDepth;
    triggers: { onOpen: boolean; onPush: boolean; drafts: boolean };
    pathExcludes: string[];
    customInstructions: string;
    pinnedHarnessIds: string[];
  };
  /** The organization's harnesses; revoked ones can't be pinned but show in the pinned list. */
  harnesses: RepositoryHarness[];
  /** Query, Reviews and Coding: the repository's own values and the organization's defaults. */
  taskTypes: TaskTypesValues;
}

/** A harness of the organization, as the Harnesses tab shows it. */
export interface RepositoryHarness {
  id: string;
  name: string;
  online: boolean;
  revoked: boolean;
  /** It is updating itself to its desired version. */
  updating: boolean;
  /** Task types it may claim jobs of, the organization's defaults filled in. */
  acceptedTaskTypes: string[];
}

/** Online, Offline or Updating (an offline harness reads as offline even mid-update). */
function harnessStatusLabel(harness: RepositoryHarness): string {
  if (!harness.online) return "Offline";
  return harness.updating ? "Updating" : "Online";
}

/** "Review, Coding", or "No task types". */
function taskTypesLabel(taskTypes: string[]): string {
  return taskTypes.length === 0 ? "No task types" : taskTypes.map(stateLabel).join(", ");
}

/** The picker hint of a pinnable harness: its status and the task types it accepts. */
export function harnessHint(harness: RepositoryHarness): string {
  return `${harnessStatusLabel(harness)} · ${taskTypesLabel(harness.acceptedTaskTypes)}`;
}

function InlineError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="settings-inline-error">
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

/** The repository-level key of a form setting (the trigger switches are saved as `triggers`). */
function inputKey(key: keyof RepositoryValues): string {
  return key === "onOpen" || key === "onPush" || key === "drafts" ? "triggers" : key;
}

const onOff = (value: boolean) => formatSettingValue(value);

/** The task-type switches a tab's section saves. */
const REVIEW_TASK_TYPES = ["review", "query"] as const satisfies readonly TaskTypeSwitch[];

/**
 * The settings of Repository › Review settings or Harnesses: each tab is one section with one
 * save. Only admins edit them; others see them read-only. Forms are seeded from the (polled) data and re-seeded only while they
 * aren't edited.
 */
export function RepositorySettingsContent({
  tab,
  repository,
  settings,
  harnesses,
  taskTypes,
}: RepositorySettingsContentProps) {
  const isAdmin = useCurrentUser().role === "admin";
  const apiAction = useApiAction();
  const disabled = !isAdmin;

  const pinnable = React.useMemo(() => harnesses.filter((h) => !h.revoked), [harnesses]);
  const context = React.useMemo(() => ({ harnessIds: pinnable.map((h) => h.id) }), [pinnable]);
  const saved = React.useMemo(() => repositoryDraft(settings), [settings]);
  const [draft, setDraft] = useSeededDraft(saved);
  const [typesDraft, setTypesDraft] = useSeededDraft(taskTypes.overrides);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const set = <K extends keyof RepositoryDraft>(key: K, value: RepositoryDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setType = (key: TaskTypeSwitch, value: boolean | null) =>
    setTypesDraft((d) => ({ ...d, [key]: value }));

  const savedValues = repositoryValues(saved, context);
  const draftValues = repositoryValues(draft, context);
  const specs = React.useMemo(
    () =>
      repositorySpecs({
        harnesses: new Map(harnesses.map((h) => [h.id, h.name])),
      }),
    [harnesses],
  );

  /** The props of the section saving `keys` and the task-type switches `types`. */
  const section = (
    keys: readonly (keyof RepositoryValues)[],
    types: readonly TaskTypeSwitch[],
    success: (input: RepositorySettingsInput) => string,
  ) => {
    const errorKeys = [...keys.map(inputKey), ...types];
    const changes = [
      ...settingChanges(
        types.map((key) => taskTypeSpec(taskTypes, key)),
        taskTypes.overrides,
        typesDraft,
      ),
      ...settingChanges(
        keys.map((key) => specs[key]),
        savedValues,
        draftValues,
      ),
    ];
    return {
      readOnly: !isAdmin,
      changes,
      onDiscard: () => {
        setDraft((d) => ({ ...d, ...pickKeys(saved, keys as (keyof RepositoryDraft)[]) }));
        setTypesDraft((d) => ({ ...d, ...pickKeys(taskTypes.overrides, types) }));
        setErrors((e) => withoutFieldErrors(e, errorKeys));
      },
      prepare: () => {
        // The saved settings with this section's changes only.
        const parsed = RepositorySettingsInput.safeParse(
          repositoryInput({ ...savedValues, ...pickKeys(draftValues, keys) }, settings.depth),
        );
        const parsedTypes = RepositoryTaskTypesInput.safeParse(typesDraft);
        if (!parsed.success || !parsedTypes.success) {
          setErrors((e) => ({
            ...withoutFieldErrors(e, errorKeys),
            ...(parsed.success ? {} : toFieldErrors(parsed.error)),
            ...(parsedTypes.success ? {} : toFieldErrors(parsedTypes.error)),
          }));
          return null;
        }
        const settingsChanged = changes.some((change) =>
          (keys as readonly string[]).includes(change.key),
        );
        return {
          // The switches, then the settings; the page refetches once, after both.
          action: () =>
            apiAction(
              saveWithTaskTypes(
                repository.id,
                taskTypes.overrides,
                parsedTypes.data,
                types,
                settingsChanged
                  ? ({ organizationId }) =>
                      api.put(
                        `/api/ui/repositories/${repository.id}/settings`,
                        mutationResultSchema,
                        { body: parsed.data, organizationId },
                      )
                  : null,
              ),
              repositoryChanged,
            ),
          success: success(parsed.data),
          onSuccess: () => setErrors((e) => withoutFieldErrors(e, errorKeys)),
          onError: (result: { fieldErrors?: FieldErrors }) =>
            setErrors((e) => ({ ...e, ...result.fieldErrors })),
        };
      },
    };
  };
  const appliesNext = () => "Saved; it applies to the next review";

  const excludeErrors = pathExcludeErrors(draft.pathExcludes, errors);
  const instructionsLength = draft.customInstructions.length;
  const reviewsOn = taskTypeOn(taskTypes, "review", typesDraft.review);

  const reviewSection = (
    <SettingsSection
      id="review-settings"
      title="Review settings"
      showTitle={false}
      description="How pull and merge requests in this repository are reviewed, and whether Omniralph answers questions about it. Changes apply to the next review; queued and running reviews keep the settings they started with."
      headerControl={
        <TaskTypeSelect
          compact
          name="review"
          values={taskTypes}
          value={typesDraft.review}
          disabled={disabled}
          error={errors.review}
          onChange={(value) => setType("review", value)}
        />
      }
      confirm={{
        consequence:
          "New reviews, mentions and chat questions of this repository use these settings. Queued and running reviews keep the settings they started with.",
      }}
      {...section(REPOSITORY_SECTIONS.review, REVIEW_TASK_TYPES, appliesNext)}
    >
      {!reviewsOn && (
        <Muted className="settings-section-off">
          Reviews are off: pull and merge requests here aren&apos;t reviewed. The settings below are
          kept and apply once reviews are on.
        </Muted>
      )}
      <SettingsSubsection
        id="review-when"
        title="When"
        description="Which pull and merge request events start a review."
      >
        <SwitchField
          id="trigger-on-open"
          label="Review when opened"
          description={withDefault(
            "Review a pull or merge request when it's opened or marked ready for review.",
            onOff(REPOSITORY_SETTING_DEFAULTS.triggers.onOpen),
          )}
          checked={draft.onOpen}
          disabled={disabled}
          onChange={(value) => set("onOpen", value)}
        />
        <SwitchField
          id="trigger-on-push"
          label="Review when pushed to"
          description={withDefault(
            "Review the new commits when it's pushed to.",
            onOff(REPOSITORY_SETTING_DEFAULTS.triggers.onPush),
          )}
          checked={draft.onPush}
          disabled={disabled}
          onChange={(value) => set("onPush", value)}
        />
        <SwitchField
          id="trigger-drafts"
          label="Include drafts"
          description={withDefault(
            "Also review draft pull requests and merge requests.",
            onOff(REPOSITORY_SETTING_DEFAULTS.triggers.drafts),
          )}
          checked={draft.drafts}
          disabled={disabled}
          onChange={(value) => set("drafts", value)}
        />
      </SettingsSubsection>

      <SettingsSubsection
        id="review-scope"
        title="Scope"
        description="What the reviewers skip, and what they should know about this repository."
      >
        <Field
          label="Path excludes"
          htmlFor="path-excludes"
          description="One glob per line. A pattern without / matches at any depth; a leading / anchors it to the repository root. Lock files, build output and generated files are always skipped. Default: not set."
        >
          <Textarea
            id="path-excludes"
            rows={4}
            disabled={disabled}
            error={excludeErrors.length > 0}
            aria-invalid={excludeErrors.length > 0}
            value={draft.pathExcludes}
            onChange={(e) => set("pathExcludes", e.target.value)}
            placeholder={"e.g. *.snap\n/docs/**\nsrc/**/*.generated.ts"}
            className="settings-mono"
          />
        </Field>
        {excludeErrors.map((message) => (
          <InlineError key={message} message={message} />
        ))}
        <Field
          label="Custom instructions"
          htmlFor="custom-instructions"
          description={`Added to every review prompt for this repository. ${instructionsLength.toLocaleString()} / ${MAX_CUSTOM_INSTRUCTIONS_LENGTH.toLocaleString()} characters. Default: not set.`}
          error={errors.customInstructions}
        >
          <Textarea
            id="custom-instructions"
            rows={4}
            disabled={disabled}
            error={Boolean(errors.customInstructions)}
            aria-invalid={Boolean(errors.customInstructions)}
            value={draft.customInstructions}
            onChange={(e) => set("customInstructions", e.target.value)}
            placeholder="e.g. We use Result types instead of exceptions; flag thrown errors in src/core."
          />
        </Field>
      </SettingsSubsection>

      <SettingsSubsection
        id="review-questions"
        title="Questions"
        description="Whether Omniralph answers questions about this repository."
      >
        <TaskTypeSelect
          name="query"
          values={taskTypes}
          value={typesDraft.query}
          disabled={disabled}
          error={errors.query}
          onChange={(value) => setType("query", value)}
        />
        {isAdmin && (
          <Muted>
            Change the organization&apos;s defaults in{" "}
            <Link href="/settings/harnesses" className="settings-link">
              Settings › Harnesses
            </Link>
            .
          </Muted>
        )}
      </SettingsSubsection>
    </SettingsSection>
  );

  const harnessOptions = React.useMemo(
    () =>
      pinnable.map((harness) => ({
        value: harness.id,
        label: harness.name,
        hint: harnessHint(harness),
      })),
    [pinnable],
  );
  const harnessNames = React.useMemo(
    () => new Map(harnesses.map((h) => [h.id, h.name])),
    [harnesses],
  );
  const pinError =
    errors.pinnedHarnessIds ??
    Object.entries(errors).find(([key]) => key.startsWith("pinnedHarnessIds."))?.[1];

  const harnessesSection = (
    <SettingsSection
      id="harnesses"
      title="Harnesses"
      showTitle={false}
      description="Which harnesses run this repository's jobs: reviews, questions and coding. Newly pinned harnesses pre-clone the repository."
      {...section(REPOSITORY_SECTIONS.harnesses, [], (input) =>
        input.pinnedHarnessIds.some((id) => !settings.pinnedHarnessIds.includes(id))
          ? "Saved; newly pinned harnesses will pre-clone the repository"
          : "Saved; it applies to the next job",
      )}
    >
      <SettingsSubsection
        id="harnesses-pinning"
        title="Pinning"
        description="Only the pinned harnesses run this repository's jobs. Leave all unpinned to let any harness run them. Default: not set (any harness)."
      >
        {pinnable.length === 0 && draft.pinnedHarnessIds.length === 0 ? (
          <Muted>No harnesses are enrolled yet; any harness that enrolls can run jobs.</Muted>
        ) : (
          <>
            <Field
              label="Pinned harnesses"
              htmlFor="pinned-harnesses"
              description={
                draftValues.pinnedHarnessIds.length === 0
                  ? "Any harness can run this repository's jobs."
                  : draftValues.pinnedHarnessIds.length === 1
                    ? "Only the pinned harness runs this repository's jobs."
                    : `Only the ${draftValues.pinnedHarnessIds.length} pinned harnesses run this repository's jobs.`
              }
              error={pinError}
            >
              <MultiSelect
                id="pinned-harnesses"
                value={draft.pinnedHarnessIds}
                onChange={(value) => set("pinnedHarnessIds", value)}
                options={harnessOptions}
                disabled={disabled}
                placeholder="Any harness"
                searchPlaceholder="Search harnesses…"
                searchLabel="Search harnesses"
                staleMessage="It was revoked or deleted. It's kept until you remove it."
                staleLabels={harnessNames}
              />
            </Field>
            <PinnedHarnessList
              pinnedIds={draft.pinnedHarnessIds}
              harnesses={harnesses}
              disabled={disabled}
              onRemove={(id) =>
                set(
                  "pinnedHarnessIds",
                  draft.pinnedHarnessIds.filter((pinned) => pinned !== id),
                )
              }
            />
          </>
        )}
      </SettingsSubsection>
    </SettingsSection>
  );

  return (
    <>
      {!isAdmin && (
        <Muted>Only admins can change repository settings; they&apos;re shown read-only.</Muted>
      )}

      <div className="settings-sections">
        {tab === "settings" && reviewSection}
        {tab === "harnesses" && harnessesSection}
      </div>
    </>
  );
}

/** A settings section's shape while the repository loads. */
function SettingsSkeleton() {
  return (
    <div className="settings-sections">
      <div className="settings-section-skeleton">
        <Skeleton width="60%" />
        {Array.from({ length: 5 }, (_, index) => (
          <Stack key={index} gap={1}>
            <Skeleton width={`${25 + ((index * 11) % 20)}%`} />
            <Skeleton width={`${55 + ((index * 17) % 35)}%`} height="2.25rem" />
          </Stack>
        ))}
      </div>
    </div>
  );
}

/**
 * Repository › Review settings or Harnesses, live (`GET /api/ui/repositories/{id}`).
 * Harnesses' online state is computed against the browser's ticking clock. A save invalidates
 * the repository, the repositories list and the harnesses.
 */
export function RepositorySettingsView({ tab }: { tab: RepositorySettingsTab }) {
  const { id } = useParams<{ id: string }>();
  const detail = useRepositoryDetail(id);
  const now = useNow();
  const repository = detail.data?.repository;
  const skeleton = <SettingsSkeleton />;

  const content = (data: RepositoryDetail) => (
    <RepositorySettingsContent
      tab={tab}
      repository={data.repository}
      settings={data.settings}
      harnesses={data.harnesses.map((harness) => withClientOnline(harness, now))}
      taskTypes={data.taskTypes}
    />
  );

  return (
    <>
      <AppHeader
        breadcrumbs={[
          { label: "Repositories", href: "/repositories" },
          { label: repository?.fullPath ?? "Repository" },
          { label: TAB_LABELS[tab] },
        ]}
      />
      <div className="detail-main">
        <PageHeader
          title={
            repository ? (
              <>
                <ProviderIcon provider={repository.provider} size={20} />
                <MonoPath value={repository.fullPath} />
              </>
            ) : (
              <Skeleton width="14rem" height="1.75rem" />
            )
          }
          description="How this repository is reviewed and built."
          meta={detail.data && <Freshness query={detail} />}
          actions={
            repository && (
              <Button asChild variant="ghost" className="page-header-ghost">
                <a href={repository.webUrl} target="_blank" rel="noreferrer">
                  <IconExternalLink size={14} />
                  Open on {repository.provider === "github" ? "GitHub" : "GitLab"}
                </a>
              </Button>
            )
          }
        />

        <RepositoryNav repositoryId={id} current={tab} />

        <QueryBoundary query={detail} skeleton={skeleton} what="the repository">
          {(data) => content(data)}
        </QueryBoundary>
      </div>
    </>
  );
}

/** `harness` with `online` computed against the browser's clock `now`, not the server's. */
function withClientOnline(
  harness: RepositoryDetail["harnesses"][number],
  now: number,
): RepositoryHarness {
  const heartbeat = harness.lastHeartbeatAt ? new Date(harness.lastHeartbeatAt) : null;
  return {
    id: harness.id,
    name: harness.name,
    online: !harness.revoked && isHarnessOnline(heartbeat, new Date(now)),
    revoked: harness.revoked,
    updating: harness.updating,
    acceptedTaskTypes: harness.acceptedTaskTypes,
  };
}

/** The pinned harnesses with their status, each removable; or that none is pinned. */
function PinnedHarnessList({
  pinnedIds,
  harnesses,
  disabled,
  onRemove,
}: {
  pinnedIds: readonly string[];
  harnesses: RepositoryHarness[];
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  if (pinnedIds.length === 0) {
    return <Muted>None pinned: jobs go to any eligible harness</Muted>;
  }
  return (
    <ul className="settings-pin-list" aria-label="Pinned harnesses">
      {pinnedIds.map((id) => {
        const harness = harnesses.find((h) => h.id === id);
        const name = harness?.name ?? "Deleted harness";
        return (
          <li key={id} className="settings-pin">
            <div className="settings-pin-main">
              <span className="settings-pin-name">{name}</span>
              <span className="settings-pin-detail">
                {harness ? taskTypesLabel(harness.acceptedTaskTypes) : "It no longer exists"}
              </span>
            </div>
            <div className="settings-pin-badges">
              {harness ? (
                <>
                  <HarnessStatusBadge harness={harness} />
                  {harness.online && harness.updating && (
                    <Badge variant={HARNESS_UPDATE_STATUS_VARIANTS.updating} dot live>
                      Updating
                    </Badge>
                  )}
                </>
              ) : (
                <Badge variant="neutral">Deleted</Badge>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              aria-label={`Unpin ${name}`}
              onClick={() => onRemove(id)}
            >
              <IconX size={14} />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
