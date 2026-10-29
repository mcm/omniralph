"use client";

import {
  Card,
  DataTable,
  formatShortcut,
  useShortcutPlatform,
  type DataTableColumn,
  type ShortcutDefinition,
} from "@omniralph/ui";
import { SHORTCUT_GROUPS, SHORTCUTS, type ShortcutId } from "@/lib/shortcuts";
import "./help.css";

/** The Keyboard shortcuts card's one line, which also covers devices without a keyboard. */
export const SHORTCUTS_INTRO =
  "Shortcuts work with a hardware keyboard. They don't run while you're typing in a field.";

interface ShortcutRow {
  id: ShortcutId;
  definition: ShortcutDefinition;
}

const ROWS: readonly ShortcutRow[] = (
  Object.entries(SHORTCUTS) as [ShortcutId, ShortcutDefinition][]
).map(([id, definition]) => ({ id, definition }));

/**
 * The Help page (`/help`, opened from the user menu): "Help", then the Keyboard shortcuts
 * card with its intro line and one table per group (Go to, Lists, Inbox, Runs, Work items,
 * Panels) of every action in `SHORTCUTS` with its key, Mod shown as ⌘ on Apple platforms and
 * Ctrl elsewhere. The same at every width: the tables become stacked cards on a phone. It's
 * the only page that shows keys (Design rule 7).
 */
export function HelpView() {
  const platform = useShortcutPlatform();
  const columns: DataTableColumn<ShortcutRow>[] = [
    { id: "action", header: "Action", cell: (row) => row.definition.label, card: "title" },
    {
      id: "key",
      header: "Key",
      cell: (row) => <kbd className="or-help__key">{formatShortcut(row.definition, platform)}</kbd>,
    },
  ];
  return (
    <div className="or-help">
      <h1 className="or-help__title">Help</h1>
      <Card title="Keyboard shortcuts">
        <p className="or-help__intro">{SHORTCUTS_INTRO}</p>
        {SHORTCUT_GROUPS.map(({ group, label }) => (
          <section key={group} className="or-help__group" aria-labelledby={`help-${group}`}>
            <h3 id={`help-${group}`} className="or-help__group-title">
              {label}
            </h3>
            <DataTable
              rows={ROWS.filter((row) => row.definition.group === group)}
              getRowId={(row) => row.id}
              columns={columns}
              caption={label}
            />
          </section>
        ))}
      </Card>
    </div>
  );
}
