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
  Muted,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import { IconPlus, IconTool, IconTrash } from "@tabler/icons-react";
import { useAction } from "@/components/use-action";
import { addHostTool, removeHostTool } from "./actions";

/** A host tool of the organization's catalog. */
export interface HostToolCatalogRow {
  id: string;
  name: string;
  description: string | null;
}

function DeleteHostTool({ tool }: { tool: HostToolCatalogRow }) {
  const { pending, run } = useAction();
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
          <AlertDialogAction
            variant="danger"
            onClick={() => run(() => removeHostTool(tool.id), `Deleted ${tool.name}`)}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AddHostToolForm() {
  const { pending, run } = useAction();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(
      () => addHostTool({ name, description }),
      `Added ${name.trim()}. Harnesses report where they find it with their next heartbeats.`,
      () => {
        setName("");
        setDescription("");
      },
    );
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

/** The organization's host tools, by name, with a form to add one. */
export function HostToolsCatalog({ hostTools }: { hostTools: HostToolCatalogRow[] }) {
  return (
    <Stack>
      {hostTools.length === 0 ? (
        <Empty
          icon={<IconTool size={24} />}
          title="No host tools"
          titleAs="h3"
          description="Add the software harness owners install by hand that tasks rely on."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {hostTools.map((tool) => (
              <TableRow key={tool.id} data-host-tool={tool.name}>
                <TableCell>
                  <span className="font-mono text-sm">{tool.name}</span>
                </TableCell>
                <TableCell>
                  {tool.description ? (
                    <span className="text-sm">{tool.description}</span>
                  ) : (
                    <Muted>—</Muted>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <DeleteHostTool tool={tool} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <AddHostToolForm />
    </Stack>
  );
}
