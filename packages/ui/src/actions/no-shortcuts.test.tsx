import { IconCopy, IconRefresh, IconTrash } from "@tabler/icons-react";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Button } from "./button.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { IconButton } from "./icon-button.js";
import { Menu } from "./menu.js";
import { Toolbar } from "./toolbar.js";
import { Tooltip } from "./tooltip.js";

// Design rule 7: no keyboard-shortcut indicators anywhere.
const noKbd = () => expect(document.querySelector("kbd")).toBeNull();
const noop = () => {};

describe("no keyboard-shortcut indicators", () => {
  it("Button, in every variant and size, with an icon, as a link and disabled", () => {
    for (const variant of ["outline", "solid", "primary", "ghost", "danger"] as const) {
      for (const size of ["md", "sm"] as const) {
        render(
          <>
            <Button variant={variant} size={size} icon={IconCopy} onClick={noop}>
              Copy
            </Button>
            <Button variant={variant} size={size} icon={IconCopy} href="/x">
              Open
            </Button>
            <Button variant={variant} size={size} icon={IconCopy} disabled>
              Copy
            </Button>
          </>,
        );
      }
    }
    noKbd();
  });

  it("IconButton and Tooltip, with their tooltips shown", async () => {
    const user = userEvent.setup();
    render(
      <>
        <IconButton
          label="Retry"
          icon={IconRefresh}
          variant="outline"
          size="sm"
          tooltipSide="bottom"
        />
        <IconButton label="Open" icon={IconRefresh} href="/x" />
        <IconButton label="Copy" icon={IconCopy} disabled />
        <Tooltip content="Explains" side="right">
          <Button>Help</Button>
        </Tooltip>
      </>,
    );
    await user.tab();
    await screen.findByRole("tooltip");
    noKbd();
    await user.hover(screen.getByRole("button", { name: "Help" }));
    await screen.findByText("Explains", { selector: "[role=tooltip]" });
    noKbd();
  });

  it("Toolbar and Menu, open, with every item kind", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Toolbar
          label="Run actions"
          actions={[
            { label: "Rerun", icon: IconRefresh, onSelect: noop },
            { label: "Open", icon: IconCopy, href: "/x", disabled: true },
          ]}
          menu={[
            { label: "Copy ID", icon: IconCopy, onSelect: noop },
            "separator",
            { label: "Settings", href: "/settings", disabled: true },
            { label: "Delete run", icon: IconTrash, onSelect: noop, destructive: true },
          ]}
        />
        <Menu
          items={[{ label: "Copy", onSelect: noop }]}
          trigger={<Button>Other</Button>}
          align="start"
          disabled
        />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await screen.findByRole("menu");
    noKbd();
  });

  it("ConfirmDialog, open, with a typed confirmation", async () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={noop}
        title="Delete repository?"
        description="Its runs are removed."
        confirmLabel="Delete"
        cancelLabel="Keep"
        destructive
        typedConfirmation="acme/web"
        onConfirm={noop}
        trigger={<Button>Delete</Button>}
      />,
    );
    await screen.findByRole("alertdialog");
    noKbd();
  });
});
