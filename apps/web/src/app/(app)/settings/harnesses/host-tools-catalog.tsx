"use client";

import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Cluster,
  Empty,
  Field,
  Input,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import { IconPlus, IconTool, IconTrash } from "@tabler/icons-react";
import { PhoneMeta, WIDE_COLUMN } from "@/components/list-table";
import { MonoValue } from "@/components/mono-value";
import { SettingsSubsection } from "@/components/settings-section";
import { useApiMutation } from "@/components/use-api-mutation";
import { EmptyValue } from "@/components/empty-value";
import { api } from "@/lib/api/client";
import {
  addedHostToolSchema,
  type AddHostToolInput,
  type HostToolCatalogRow,
} from "@/lib/api/agent-defaults";
import { mutationResultSchema } from "@/lib/api/schemas";
import { hostToolsChanged } from "./harness-defaults-queries";

export type { HostToolCatalogRow };

function DeleteHostTool({ tool }: { tool: HostToolCatalogRow }) {
  const remove = useApiMutation({
    mutationFn: (_: void, { organizationId }) =>
      api.delete(`/api/ui/host-tools/${tool.id}`, mutationResultSchema, { organizationId }),
    invalidate: hostToolsChanged,
    success: `Deleted ${tool.name}`,
  });
  const pending = remove.isPending;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={pending} aria-label={`Delete ${tool.name}`}>
          <IconTrash size={14} />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {tool.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Every harness&apos;s configured path for it is deleted too, and tasks can no longer rely
            on it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="danger" onClick={() => remove.mutate()}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AddHostToolForm() {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const add = useApiMutation({
    mutationFn: (input: AddHostToolInput, { organizationId }) =>
      api.post("/api/ui/host-tools", addedHostToolSchema, { body: input, organizationId }),
    invalidate: hostToolsChanged,
    success: (_, input) =>
      `Added ${input.name.trim()}. Harnesses report where they find it with their next heartbeats.`,
    onSuccess: () => {
      setName("");
      setDescription("");
    },
  });
  const pending = add.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    add.mutate({ name, description });
  };

  return (
    <Stack asChild>
      <form onSubmit={submit} aria-label="Add a host tool">
        <Cluster gap={4} align="stretch">
          <Field
            label="Name"
            htmlFor="host-tool-name"
            description="The executable's name, e.g. semgrep: lowercase letters, digits, dots, dashes and underscores."
            className="host-tools-name"
          >
            <Input
              id="host-tool-name"
              name="name"
              required
              disabled={pending}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field
            label="Description"
            htmlFor="host-tool-description"
            description="Optional: what it's for or how to install it."
            className="host-tools-description"
          >
            <Input
              id="host-tool-description"
              name="description"
              disabled={pending}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </Cluster>
        <div>
          <Button type="submit" variant="primary" disabled={pending || !name.trim()}>
            <IconPlus size={14} />
            {pending ? "Adding…" : "Add host tool"}
          </Button>
        </div>
      </form>
    </Stack>
  );
}

/** The organization's host tools, by name, then a form to add one: a section's two subsections. */
export function HostToolsCatalog({ hostTools }: { hostTools: HostToolCatalogRow[] }) {
  return (
    <>
      <SettingsSubsection id="host-tools-catalog" className="settings-sub-wide" title="Catalog">
        <HostToolsTable hostTools={hostTools} />
      </SettingsSubsection>
      <SettingsSubsection
        id="host-tools-add"
        title="Add a host tool"
        description="Harnesses report where they find it with their next heartbeats."
      >
        <AddHostToolForm />
      </SettingsSubsection>
    </>
  );
}

function HostToolsTable({ hostTools }: { hostTools: HostToolCatalogRow[] }) {
  return (
    <>
      {hostTools.length === 0 ? (
        <Empty
          icon={<IconTool size={24} />}
          title="No host tools"
          titleAs="h3"
          description="Add the software harness owners install by hand that tasks rely on."
        />
      ) : (
        <Table className="list-table">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className={WIDE_COLUMN}>Description</TableHead>
              <TableHead aria-label="Actions" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {hostTools.map((tool) => (
              <TableRow key={tool.id} data-host-tool={tool.name}>
                <TableCell>
                  <MonoValue value={tool.name} className="text-sm" />
                  {tool.description && (
                    <PhoneMeta>
                      <span className="text-sm">{tool.description}</span>
                    </PhoneMeta>
                  )}
                </TableCell>
                <TableCell className={WIDE_COLUMN}>
                  {tool.description ? (
                    <span className="text-sm">{tool.description}</span>
                  ) : (
                    <EmptyValue />
                  )}
                </TableCell>
                <TableCell className="list-actions">
                  <DeleteHostTool tool={tool} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
