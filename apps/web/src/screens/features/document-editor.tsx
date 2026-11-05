"use client";

import {
  Button,
  EmptyState,
  IconButton,
  Markdown,
  SegmentedControl,
  Sheet,
  Textarea,
  type ButtonIcon,
} from "@omniralph/ui";
import {
  IconBlockquote,
  IconBold,
  IconCode,
  IconHeading,
  IconHistory,
  IconItalic,
  IconLink,
  IconList,
  IconListNumbers,
} from "@tabler/icons-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ApiError } from "@/lib/api/client";
import type { FeatureDocumentKindValue, FeatureDocumentRow } from "@/lib/api/features";
import { formatDateTime } from "@/lib/format-date";
import { documentLabel } from "./feature-status";
import { applyFormat, type FormatCommand, type TextSelection } from "./markdown-format";
import { useSaveDocument } from "./mutations";
import {
  useFeatureDocument,
  useFeatureDocumentVersion,
  useFeatureDocumentVersions,
} from "./queries";

/** How long typing pauses before the document saves itself, in milliseconds. */
export const AUTOSAVE_DELAY_MS = 1200;

export const SAVING = "Saving…";
export const UNSAVED = "Unsaved changes";
export const NOT_SAVED_YET = "Not saved yet";
export const STALE_SAVE_TITLE = "Someone else saved first";
export const staleSaveMessage = (label: string) =>
  `Someone saved a newer version of this ${label} while you were editing, so your latest changes aren't saved. Load their version to start again from it, or replace it with yours.`;
export const LOAD_THEIRS = "Load their version";
export const KEEP_MINE = "Replace with mine";
export const RESTORE_VERSION = "Restore this version";
export const documentLoadFailed = (label: string) => `Couldn't load the ${label}`;
export const noDocumentYet = (label: string) => `No ${label} yet`;

const PLACEHOLDERS: Record<FeatureDocumentKindValue, string> = {
  prfaq:
    "Write the PRFAQ in Markdown: the press release announcing the feature, then the questions people will ask.",
  plan: "Write the Plan in Markdown: how the feature gets built, ending with ## Epics, one ### per epic.",
};

const EMPTY_HINTS: Record<FeatureDocumentKindValue, string> = {
  prfaq: "An admin writes it here, or drafts it with the PRD plugin's prfaq mode.",
  plan: "An admin writes it here, or drafts it with the PRD plugin's plan mode.",
};

const FORMATS: readonly { command: FormatCommand; label: string; icon: ButtonIcon }[] = [
  { command: "heading", label: "Section heading", icon: IconHeading },
  { command: "bold", label: "Bold", icon: IconBold },
  { command: "italic", label: "Italic", icon: IconItalic },
  { command: "bulletList", label: "Bulleted list", icon: IconList },
  { command: "numberedList", label: "Numbered list", icon: IconListNumbers },
  { command: "quote", label: "Quote", icon: IconBlockquote },
  { command: "code", label: "Code", icon: IconCode },
  { command: "link", label: "Link", icon: IconLink },
];

export interface DocumentEditorProps {
  featureId: string;
  kind: FeatureDocumentKindValue;
  /** Edits allowed: an admin, on a feature that isn't archived. Otherwise it only reads. */
  editable: boolean;
  /** Overrides `AUTOSAVE_DELAY_MS` (tests). */
  autosaveDelay?: number;
}

function DocumentSkeleton({ label }: { label: string }) {
  return (
    <div className="or-feature-doc" role="status" data-testid="document-skeleton">
      <span className="or-sr-only">Loading the {label}…</span>
      <div aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="or-feature-skeleton__line" />
        ))}
      </div>
    </div>
  );
}

/**
 * A feature's PRFAQ or Plan: a skeleton while it loads, a retry when it can't, else the
 * document, editable or read-only. A live query: a version someone else saves shows up
 * by itself while there are no unsaved changes.
 */
export function DocumentEditor({
  featureId,
  kind,
  editable,
  autosaveDelay = AUTOSAVE_DELAY_MS,
}: DocumentEditorProps) {
  const label = documentLabel(kind);
  const document = useFeatureDocument(featureId, kind);
  if (document.isPending) return <DocumentSkeleton label={label} />;
  if (document.isError) {
    return (
      <EmptyState
        headingLevel={3}
        title={documentLoadFailed(label)}
        description={document.error.message}
        action={
          <Button variant="outline" onClick={() => void document.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  return (
    <DocumentBody
      key={`${featureId}:${kind}`}
      featureId={featureId}
      kind={kind}
      label={label}
      document={document.data}
      editable={editable}
      autosaveDelay={autosaveDelay}
      reload={async () => (await document.refetch()).data}
    />
  );
}

/** What's in the editor: the text, the version it started from, and whether it's saved. */
interface Draft {
  body: string;
  baseVersion: number;
  dirty: boolean;
}

interface DocumentBodyProps {
  featureId: string;
  kind: FeatureDocumentKindValue;
  label: string;
  document: FeatureDocumentRow;
  editable: boolean;
  autosaveDelay: number;
  /** Refetches the latest version. */
  reload: () => Promise<FeatureDocumentRow | undefined>;
}

function DocumentBody({
  featureId,
  kind,
  label,
  document,
  editable,
  autosaveDelay,
  reload,
}: DocumentBodyProps) {
  const save = useSaveDocument(featureId, kind);
  const [draft, setDraft] = useState<Draft>({
    body: document.body,
    baseVersion: document.version,
    dirty: false,
  });
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [historyOpen, setHistoryOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);

  // A newer version saved elsewhere replaces the text while nothing here is unsaved.
  const [seenVersion, setSeenVersion] = useState(document.version);
  if (document.version !== seenVersion) {
    setSeenVersion(document.version);
    if (!draft.dirty && !save.isPending && document.version > draft.baseVersion) {
      setDraft({ body: document.body, baseVersion: document.version, dirty: false });
    }
  }

  const saveNow = (body: string, baseVersion: number) => {
    setSaveError(null);
    save.mutate(
      { body, baseVersion },
      {
        onSuccess: (result) =>
          setDraft((current) => ({
            body: current.body,
            baseVersion: result.document.version,
            dirty: current.body !== body,
          })),
        onError: (error) => {
          if (error instanceof ApiError && error.code === "stale_version") setConflict(true);
          else setSaveError(error.message);
        },
      },
    );
  };

  // The latest `saveNow`, for the autosave timer: the draft and the gate decide when it fires.
  const latestSave = useRef(saveNow);
  useEffect(() => {
    latestSave.current = saveNow;
  });

  const canSave = editable && draft.dirty && !conflict && !save.isPending && saveError === null;
  // Autosave: once typing pauses.
  useEffect(() => {
    if (!canSave) return;
    const timer = setTimeout(
      () => latestSave.current(draft.body, draft.baseVersion),
      autosaveDelay,
    );
    return () => clearTimeout(timer);
  }, [canSave, draft.body, draft.baseVersion, autosaveDelay]);

  // Leaving the page with unsaved changes asks first.
  useEffect(() => {
    if (!editable || !draft.dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editable, draft.dirty]);

  useLayoutEffect(() => {
    const selection = pendingSelection.current;
    if (!selection || !textarea.current) return;
    pendingSelection.current = null;
    textarea.current.focus();
    textarea.current.setSelectionRange(selection.start, selection.end);
  });

  const edit = (body: string) => {
    setSaveError(null);
    setDraft((current) => ({ ...current, body, dirty: true }));
  };

  const format = (command: FormatCommand) => {
    const element = textarea.current;
    const selection: TextSelection = {
      text: draft.body,
      start: element?.selectionStart ?? draft.body.length,
      end: element?.selectionEnd ?? draft.body.length,
    };
    const next = applyFormat(command, selection);
    pendingSelection.current = { start: next.start, end: next.end };
    edit(next.text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    const command = event.key === "b" ? "bold" : event.key === "i" ? "italic" : null;
    if (!command) return;
    event.preventDefault();
    format(command);
  };

  const loadTheirs = async () => {
    const latest = await reload();
    if (!latest) return;
    setDraft({ body: latest.body, baseVersion: latest.version, dirty: false });
    setConflict(false);
  };
  const keepMine = async () => {
    const latest = await reload();
    if (!latest) return;
    setConflict(false);
    setDraft((current) => ({ ...current, baseVersion: latest.version }));
    saveNow(draft.body, latest.version);
  };

  const restore = (body: string) => {
    edit(body);
    setMode("write");
    setHistoryOpen(false);
  };

  const status = conflict
    ? null
    : save.isPending
      ? SAVING
      : saveError
        ? `Not saved: ${saveError}`
        : draft.dirty
          ? UNSAVED
          : draft.baseVersion === 0
            ? NOT_SAVED_YET
            : `Saved · version ${draft.baseVersion}${
                document.version === draft.baseVersion && document.savedAt
                  ? ` · ${formatDateTime(document.savedAt)}`
                  : ""
              }`;

  const history =
    document.version > 0 ? (
      <Button variant="ghost" size="sm" icon={IconHistory} onClick={() => setHistoryOpen(true)}>
        History
      </Button>
    ) : null;

  const historySheet = (
    <VersionHistory
      open={historyOpen}
      onOpenChange={setHistoryOpen}
      featureId={featureId}
      kind={kind}
      label={label}
      currentVersion={document.version}
      onRestore={editable ? restore : undefined}
    />
  );

  if (!editable) {
    return (
      <div className="or-feature-doc">
        <div className="or-feature-doc__bar">
          <span className="or-feature-doc__status">
            {document.version === 0
              ? NOT_SAVED_YET
              : `Version ${document.version}${document.savedAt ? ` · ${formatDateTime(document.savedAt)}` : ""}`}
          </span>
          {history}
        </div>
        {document.body.trim() === "" ? (
          <EmptyState
            headingLevel={3}
            title={noDocumentYet(label)}
            description={EMPTY_HINTS[kind]}
          />
        ) : (
          <Markdown className="or-feature-doc__preview">{document.body}</Markdown>
        )}
        {historySheet}
      </div>
    );
  }

  return (
    <div className="or-feature-doc">
      <div className="or-feature-doc__bar">
        <SegmentedControl
          aria-label={`${label} view`}
          size="sm"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: "write", label: "Write" },
            { value: "preview", label: "Preview" },
          ]}
        />
        {mode === "write" ? (
          <div className="or-feature-doc__formats" role="toolbar" aria-label="Formatting">
            {FORMATS.map((item) => (
              <IconButton
                key={item.command}
                size="sm"
                icon={item.icon}
                label={item.label}
                onClick={() => format(item.command)}
              />
            ))}
          </div>
        ) : null}
        <span className="or-feature-doc__status" role="status" aria-live="polite">
          {status}
          {saveError ? (
            <>
              {" "}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => saveNow(draft.body, draft.baseVersion)}
              >
                Try again
              </Button>
            </>
          ) : null}
        </span>
        {history}
      </div>

      {conflict ? (
        <div className="or-feature-doc__conflict" role="alert">
          <p className="or-feature-doc__conflict-title">{STALE_SAVE_TITLE}</p>
          <p>{staleSaveMessage(label)}</p>
          <div className="or-feature-doc__conflict-actions">
            <Button variant="outline" size="sm" onClick={() => void loadTheirs()}>
              {LOAD_THEIRS}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void keepMine()}>
              {KEEP_MINE}
            </Button>
          </div>
        </div>
      ) : null}

      {mode === "write" ? (
        <Textarea
          ref={textarea}
          aria-label={label}
          className="or-feature-doc__input"
          mono
          rows={22}
          value={draft.body}
          placeholder={PLACEHOLDERS[kind]}
          onChange={(event) => edit(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (canSave) saveNow(draft.body, draft.baseVersion);
          }}
        />
      ) : draft.body.trim() === "" ? (
        <p className="or-feature-doc__placeholder">Nothing written yet.</p>
      ) : (
        <Markdown className="or-feature-doc__preview">{draft.body}</Markdown>
      )}
      {historySheet}
    </div>
  );
}

interface VersionHistoryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  featureId: string;
  kind: FeatureDocumentKindValue;
  label: string;
  currentVersion: number;
  /** Puts a version's text in the editor (it saves as a new version); none read-only. */
  onRestore?: (body: string) => void;
}

/**
 * A document's History (a `Sheet`): every saved version, newest first, with when and who;
 * picking one shows it, and an editor can restore it (saved as a new version).
 */
function VersionHistory({
  open,
  onOpenChange,
  featureId,
  kind,
  label,
  currentVersion,
  onRestore,
}: VersionHistoryProps) {
  const versions = useFeatureDocumentVersions(featureId, kind, open);
  const [picked, setPicked] = useState<number | null>(null);
  const shown = picked ?? (open ? currentVersion || null : null);
  const version = useFeatureDocumentVersion(featureId, kind, shown);

  return (
    <Sheet
      title={`${label} history`}
      description="Every save is a version. Pick one to read it."
      open={open}
      onOpenChange={(next) => {
        if (!next) setPicked(null);
        onOpenChange(next);
      }}
      footer={
        <>
          {onRestore && shown !== null && shown !== currentVersion && version.data ? (
            <Button variant="solid" onClick={() => onRestore(version.data.body)}>
              {RESTORE_VERSION}
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </>
      }
    >
      <div className="or-feature-history">
        {versions.isPending ? (
          <p role="status">Loading versions…</p>
        ) : versions.isError ? (
          <p className="or-feature__error" role="alert">
            Couldn&apos;t load the versions. {versions.error.message}
          </p>
        ) : (
          <ol className="or-feature-history__list" aria-label="Versions">
            {versions.data.versions.map((entry) => (
              <li key={entry.version}>
                <button
                  type="button"
                  className="or-feature-history__version"
                  aria-pressed={entry.version === shown}
                  onClick={() => setPicked(entry.version)}
                >
                  <span className="or-feature-history__name">
                    Version {entry.version}
                    {entry.version === currentVersion ? " (current)" : ""}
                  </span>
                  <span className="or-feature-history__meta">
                    {formatDateTime(entry.savedAt)}
                    {entry.savedBy ? ` · ${entry.savedBy}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
        {shown !== null ? (
          <section className="or-feature-history__preview" aria-label={`Version ${shown}`}>
            {version.isPending ? (
              <p role="status">Loading version {shown}…</p>
            ) : version.isError ? (
              <p className="or-feature__error" role="alert">
                {version.error.message}
              </p>
            ) : version.data.body.trim() === "" ? (
              <p className="or-feature-doc__placeholder">This version is empty.</p>
            ) : (
              <Markdown>{version.data.body}</Markdown>
            )}
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}
