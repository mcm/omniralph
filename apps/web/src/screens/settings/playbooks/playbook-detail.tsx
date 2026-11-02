"use client";

import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  MetaBadge,
  RepoBadge,
  toast,
  Toolbar,
  useLinkComponent,
  type MenuItem,
} from "@omniralph/ui";
import {
  CODING_DEFAULTS,
  playbookLoopSettings,
  roleLoops,
  roleTaskType,
  type Playbook,
} from "@omniralph/tasks";
import {
  IconCopy,
  IconCopyPlus,
  IconMessageCircle,
  IconPencil,
  IconTrash,
} from "@tabler/icons-react";
import { useRouter } from "next/navigation";
import { createElement, useState, type ReactNode } from "react";
import { useCurrentUser } from "@/components/current-user";
import { useApiMutation } from "@/components/use-api-mutation";
import { api, ApiError } from "@/lib/api/client";
import { playbookKeys } from "@/lib/api/playbook-keys";
import {
  deletedPlaybookSchema,
  playbookPath,
  savedPlaybookSchema,
  type PlaybookDetail as PlaybookDetailData,
  type PlaybookUsedBy,
  type SavedPlaybook,
} from "@/lib/api/playbooks";
import { hasRole } from "@/lib/auth/roles";
import { SettingsPage } from "../settings-page";
import {
  CHAT_PLAYBOOK_LABELS,
  isUnused,
  modelLabel,
  PLAYBOOK_ROLE_LABELS,
  PLAYBOOKS_PATH,
  playbookEditHref,
  playbookHref,
  REPOSITORY_BINDING_LABELS,
  roleTriggerLabels,
  trackerToolLabel,
} from "./labels";
import { usePlaybook, writeDeletedPlaybook, writeSavedPlaybook } from "./queries";
import "./playbooks.css";

/** Shown for an unknown playbook, or another organization's. */
export const PLAYBOOK_NOT_FOUND = "This playbook doesn't exist.";

/** The state an epic moves to when every story is done, in words. */
export function epicCompletedStateLabel(state: string | null): string {
  if (state === null) return "Left as it is";
  if (state === "started") return "The team's first started state";
  if (state === "completed") return "The team's first completed state";
  return state;
}

/** A duration in minutes in words: whole days or hours when it is one. */
export function minutesLabel(minutes: number): string {
  const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? "" : "s"}`;
  if (minutes % 1440 === 0) return unit(minutes / 1440, "day");
  if (minutes % 60 === 0) return unit(minutes / 60, "hour");
  return unit(minutes, "minute");
}

/**
 * The ⋯ menu's items: Copy playbook ID, and for an admin on a custom playbook "Edit" and,
 * after a separator, "Delete…".
 */
export function playbookMenuItems(id: string, edit?: { onDelete: () => void }): MenuItem[] {
  return [
    {
      label: "Copy playbook ID",
      icon: IconCopy,
      onSelect: () => void copyPlaybookId(id),
    },
    ...(edit
      ? ([
          { label: "Edit", icon: IconPencil, href: playbookEditHref(id) },
          "separator",
          { label: "Delete…", icon: IconTrash, destructive: true, onSelect: edit.onDelete },
        ] satisfies MenuItem[])
      : []),
  ];
}

async function copyPlaybookId(id: string) {
  try {
    await navigator.clipboard.writeText(id);
    toast("Playbook ID copied");
  } catch {
    toast("Couldn't copy the playbook ID.", { variant: "danger" });
  }
}

/**
 * A link through the provider's link component (Next.js in the app), created with
 * `createElement`: it comes from a hook, and JSX would read as a component made during render.
 */
function AppLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const link = useLinkComponent();
  return createElement(link, { href, className }, children);
}

function None({ children = "None" }: { children?: ReactNode }) {
  return <span className="or-playbook__none">{children}</span>;
}

/** One fact of a card: its term and value. */
function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="or-playbook__fact">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A read-only prompt in a mono block. */
function PromptBlock({ label, text }: { label: string; text: string }) {
  return (
    <figure className="or-playbook__prompt">
      <figcaption>{label}</figcaption>
      {text.trim() === "" ? <None /> : <pre className="or-mono">{text}</pre>}
    </figure>
  );
}

/** Commands as a numbered list (Design rule 19), or "None". */
function CommandList({ label, commands }: { label: string; commands: readonly string[] }) {
  if (commands.length === 0) return <None />;
  return (
    <ol className="or-playbook__commands" aria-label={label}>
      {commands.map((command, index) => (
        <li key={index}>
          <code className="or-mono">{command}</code>
        </li>
      ))}
    </ol>
  );
}

/** Mono badges for a list of names, or "None". */
/** Names as mono badges, or as plain-words badges when `labelOf` reads them. */
function NameBadges({
  label,
  names,
  labelOf,
}: {
  label: string;
  names: readonly string[];
  labelOf?: (name: string) => string;
}) {
  if (names.length === 0) return <None />;
  return (
    <ul className="or-playbook__badges" aria-label={label}>
      {names.map((name) => (
        <li key={name}>
          {labelOf ? <MetaBadge text={labelOf(name)} /> : <MetaBadge text={name} mono />}
        </li>
      ))}
    </ul>
  );
}

function onOff(value: boolean): string {
  return value ? "On" : "Off";
}

function ModelValue({ playbook, model }: { playbook: Playbook; model: string | null }) {
  return model === null ? (
    <None>{modelLabel(playbook.role, model)}</None>
  ) : (
    <span className="or-mono">{model}</span>
  );
}

/** Role, model, fallback model and token budget. */
function OverviewCard({ detail }: { detail: PlaybookDetailData }) {
  const { playbook } = detail;
  return (
    <Card title="Overview">
      {playbook.description ? <p className="or-playbook__lead">{playbook.description}</p> : null}
      <dl className="or-playbook__facts">
        <Fact term="Role">{PLAYBOOK_ROLE_LABELS[playbook.role]}</Fact>
        <Fact term="Starts on">
          <NameBadges label="Triggers" names={roleTriggerLabels(playbook.role)} labelOf={String} />
        </Fact>
        <Fact term="Model">
          <ModelValue playbook={playbook} model={playbook.model} />
        </Fact>
        <Fact term="Fallback model">
          {playbook.fallbackModel === null && roleTaskType(playbook.role) !== "review" ? (
            <None />
          ) : (
            <ModelValue playbook={playbook} model={playbook.fallbackModel} />
          )}
        </Fact>
        <Fact term="Token budget">{detail.tokenBudgetLabel}</Fact>
      </dl>
    </Card>
  );
}

/** The system prompt and prompt template, read-only. */
function PromptsCard({ playbook }: { playbook: Playbook }) {
  return (
    <Card title="Prompts">
      <PromptBlock
        label={
          playbook.systemPromptMode === "replace"
            ? "System prompt (replaces Claude Code's)"
            : "System prompt (added to Claude Code's)"
        }
        text={playbook.systemPrompt}
      />
      <PromptBlock label="Prompt template" text={playbook.promptTemplate} />
    </Card>
  );
}

/** The tools per group, and what the session may reach. */
function ToolsCard({ playbook }: { playbook: Playbook }) {
  const { tools, toolSettings } = playbook;
  return (
    <Card title="Tools">
      <dl className="or-playbook__facts">
        <Fact term="Built-in">
          <NameBadges label="Built-in tools" names={tools.builtin} />
        </Fact>
        <Fact term="Agent">
          <NameBadges label="Agent tools" names={tools.agent} />
        </Fact>
        <Fact term="Tracker">
          <NameBadges label="Tracker tools" names={tools.tracker} labelOf={trackerToolLabel} />
        </Fact>
        <Fact term="MCP servers">
          <NameBadges label="MCP servers" names={tools.mcpServers} />
        </Fact>
        <Fact term="Shell access">{onOff(toolSettings.shell)}</Fact>
        <Fact term="Network access">{onOff(toolSettings.network)}</Fact>
      </dl>
    </Card>
  );
}

/** What an agent needs to run it. */
function RequirementsCard({ detail }: { detail: PlaybookDetailData }) {
  const { requirements } = detail;
  return (
    <Card title="Requirements">
      <dl className="or-playbook__facts">
        <Fact term="Agent version">
          {requirements.minAgentVersion === null ? (
            <None>Any</None>
          ) : (
            <MetaBadge text={`${requirements.minAgentVersion} or later`} mono />
          )}
        </Fact>
        <Fact term="Packages">
          <NameBadges label="Packages" names={requirements.installables} />
        </Fact>
        <Fact term="Host tools">
          <NameBadges label="Host tools" names={requirements.hostTools} />
        </Fact>
      </dl>
    </Card>
  );
}

/** Setup and teardown commands, numbered. */
function CommandsCard({ playbook }: { playbook: Playbook }) {
  return (
    <Card title="Commands">
      <dl className="or-playbook__facts">
        <Fact term="Setup">
          <CommandList
            label="Setup commands"
            commands={playbook.setupCommands.map((command) => command.command)}
          />
        </Fact>
        <Fact term="Teardown">
          <CommandList
            label="Teardown commands"
            commands={playbook.teardownCommands.map((command) => command.command)}
          />
        </Fact>
      </dl>
    </Card>
  );
}

/** A story or request playbook's coding settings, unset ones at their defaults. */
function CodingCard({ playbook }: { playbook: Playbook }) {
  const coding = { ...CODING_DEFAULTS, ...dropUndefined(playbook.coding ?? {}) };
  return (
    <Card title="Coding">
      <dl className="or-playbook__facts">
        <Fact term="Worktree setup">
          {coding.worktreeSetupCommand ? (
            <code className="or-mono">{coding.worktreeSetupCommand}</code>
          ) : (
            <None />
          )}
        </Fact>
        <Fact term="PRD quality gates">
          {coding.runPrdQualityGates ? "Runs them after the repo's checks" : "Skipped"}
        </Fact>
        <Fact term="Preparation">
          {coding.allowPreparation
            ? "Offers to run a manual story's preparation commands"
            : "Not offered"}
        </Fact>
        <Fact term="Epic completed state">
          {epicCompletedStateLabel(coding.epicCompletedState)}
        </Fact>
        <Fact term="Merged worktree cleanup">
          {coding.cleanupMergedWorktrees
            ? "Removes the worktree and branch after the pull request merges"
            : "Keeps them"}
        </Fact>
        <Fact term="Unmerged branch timeout">
          {minutesLabel(coding.unmergedBranchTimeoutMinutes)}
        </Fact>
      </dl>
    </Card>
  );
}

/** A count in words: "1 attempt", "3 attempts". */
function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * A looped playbook's loop settings, unset ones at their defaults: a story playbook's
 * attempts and rounds, any other looped playbook's iterations.
 */
function LoopCard({ playbook }: { playbook: Playbook }) {
  const loop = playbookLoopSettings(playbook);
  if (loop === null) {
    const coding = { ...CODING_DEFAULTS, ...dropUndefined(playbook.coding ?? {}) };
    return (
      <Card title="Loop">
        <dl className="or-playbook__facts">
          <Fact term="Attempts per story">{countLabel(coding.maxAttemptsPerStory, "attempt")}</Fact>
          <Fact term="Rounds per story">{countLabel(coding.maxRoundsPerStory, "round")}</Fact>
          <Fact term="Stall rounds">
            Set aside after {countLabel(coding.stallRounds, "round")} without a better score
          </Fact>
        </dl>
      </Card>
    );
  }
  return (
    <Card title="Loop">
      <dl className="or-playbook__facts">
        <Fact term="Most iterations">{countLabel(loop.maxIterations, "iteration")}</Fact>
        <Fact term="Stall rounds">
          Stops after {countLabel(loop.stallRounds, "iteration")} without a better score
        </Fact>
      </dl>
    </Card>
  );
}

function dropUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

/** Every repo, chat setting and playbook using it. */
function UsedByCard({ usedBy }: { usedBy: PlaybookUsedBy }) {
  return (
    <Card title="Used by">
      {isUnused(usedBy) ? (
        <None>Not used</None>
      ) : (
        <ul className="or-playbook__used-by">
          {usedBy.repositories.map((repo) => (
            <li key={repo.id}>
              <RepoBadge host={repo.provider} name={repo.fullPath} />
              <span>{repo.roles.map((role) => REPOSITORY_BINDING_LABELS[role]).join(", ")}</span>
            </li>
          ))}
          {usedBy.chatPlaybooks.length > 0 ? (
            <li>
              <MetaBadge icon={IconMessageCircle} text="Chat" />
              <span>
                {usedBy.chatPlaybooks.map((role) => CHAT_PLAYBOOK_LABELS[role]).join(", ")}
              </span>
            </li>
          ) : null}
          {usedBy.chatChannels.map((channel) => (
            <li key={`${channel.connectionId}:${channel.channelId}`}>
              <MetaBadge
                icon={IconMessageCircle}
                text={`${channel.connectionName} › ${channel.channelId}`}
              />
              <span>{channel.roles.map((role) => CHAT_PLAYBOOK_LABELS[role]).join(", ")}</span>
            </li>
          ))}
          {usedBy.playbooks.map((user) => (
            <li key={user.id}>
              <AppLink href={playbookHref(user.id)}>{user.name}</AppLink>
              <span>Pull request description</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * Advanced › Playbooks › one playbook: its role, model and budget, the system prompt and
 * prompt template, tools, requirements, commands, a coding playbook's coding settings and
 * what uses it, with the toolbar: admins get Clone (a copy opened in the editor) and, on a
 * custom playbook, ⋯ Edit and Delete… (confirmed; the server refuses one in use). Live: an
 * edit, a delete or a binding change by anyone shows at once; an unknown playbook (another
 * organization's too) says so.
 */
export function PlaybookDetail({ id }: { id: string }) {
  const query = usePlaybook(id);
  const router = useRouter();
  const isAdmin = hasRole(useCurrentUser(), "admin");
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const clone = useApiMutation<SavedPlaybook, void>({
    mutationFn: (_none, { organizationId }) =>
      api.post(playbookPath(id, "clone"), savedPlaybookSchema, { organizationId }),
    applyResult: (saved, cache) => writeSavedPlaybook(cache, saved),
    invalidate: (keys) => [playbookKeys(keys).all],
    success: (saved) => `Created ${saved.summary.name}`,
    onSuccess: (saved) => router.push(playbookEditHref(saved.id)),
  });
  const remove = useApiMutation<{ ok: true }, string>({
    mutationFn: (_name, { organizationId }) =>
      api.delete(playbookPath(id), deletedPlaybookSchema, { organizationId }),
    applyResult: (_result, cache) => writeDeletedPlaybook(cache, id),
    invalidate: (keys) => [playbookKeys(keys).list],
    success: (_result, name) => `Deleted ${name}`,
    onSuccess: () => {
      // The page is on its way to the list: don't refetch the playbook it no longer has.
      setLeaving(true);
      router.push(PLAYBOOKS_PATH);
    },
  });
  if (leaving) return null;
  const back = (
    <AppLink href={PLAYBOOKS_PATH} className="or-playbook__back">
      ‹ Playbooks
    </AppLink>
  );
  if (query.isPending) return <p aria-busy="true">Loading…</p>;
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) {
      return (
        <div className="or-settings-page">
          {back}
          <EmptyState headingLevel={2} title={PLAYBOOK_NOT_FOUND} />
        </div>
      );
    }
    return (
      <EmptyState
        headingLevel={2}
        title="Couldn't load this playbook"
        description={query.error.message}
        action={
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  const detail = query.data;
  const { playbook } = detail;
  return (
    <SettingsPage title={playbook.name}>
      <div className="or-playbook__head">
        {back}
        <div className="or-playbook__badges or-playbook__head-badges">
          <MetaBadge text={PLAYBOOK_ROLE_LABELS[playbook.role]} />
          {detail.builtin ? <MetaBadge text="Built-in" /> : null}
        </div>
        <Toolbar
          label="Playbook actions"
          actions={
            isAdmin
              ? [
                  {
                    label: "Clone",
                    icon: IconCopyPlus,
                    disabled: clone.isPending,
                    onSelect: () => clone.mutate(),
                  },
                ]
              : []
          }
          menu={playbookMenuItems(
            playbook.id,
            isAdmin && !detail.builtin ? { onDelete: () => setConfirming(true) } : undefined,
          )}
        />
      </div>
      <OverviewCard detail={detail} />
      <PromptsCard playbook={playbook} />
      <ToolsCard playbook={playbook} />
      <RequirementsCard detail={detail} />
      <CommandsCard playbook={playbook} />
      {roleLoops(playbook.role) ? <LoopCard playbook={playbook} /> : null}
      {roleTaskType(playbook.role) === "coding" ? <CodingCard playbook={playbook} /> : null}
      <UsedByCard usedBy={detail.usedBy} />
      {isAdmin && !detail.builtin ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={`Delete ${playbook.name}?`}
          description="This can't be undone."
          confirmLabel="Delete playbook"
          destructive
          onConfirm={() => remove.mutate(playbook.name)}
        />
      ) : null}
    </SettingsPage>
  );
}
