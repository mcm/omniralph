import { CHANGE_RESOURCES as DB_CHANGE_RESOURCES } from "@omniralph/db";
import { harnessWakeChannel, orgWakeChannel } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import {
  CHANGE_RESOURCES,
  changeEventSchema,
  changeEventSchemas,
  orgChangesChannel,
  parseChangeEvent,
  userChangesChannel,
  type ChangeEvent,
} from "./events";

const ID = "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f";
const ORG = "0b7d9a2e-4c1f-4e8a-9b3d-5f6a7b8c9d0e";

/** The only fields an event may carry: IDs, the resource, a section name, the version and time. */
const ALLOWED_FIELDS = new Set([
  "v",
  "resource",
  "ids",
  "organizationId",
  "at",
  "runId",
  "section",
  "subjectId",
]);

function sample(resource: (typeof CHANGE_RESOURCES)[number]): ChangeEvent {
  const base = { v: 1 as const, ids: [ID], organizationId: ORG, at: "2026-10-25T12:00:00.000Z" };
  if (resource === "settings") return { ...base, resource, section: "routing_rules" };
  if (resource === "inbox_state") return { ...base, resource, ids: [`manual_story:${ID}`] };
  return { ...base, resource } as unknown as ChangeEvent;
}

describe("the change-event catalogue", () => {
  it("has a schema for every resource, matching the resources the db layer records", () => {
    expect([...CHANGE_RESOURCES].sort()).toEqual([...DB_CHANGE_RESOURCES].sort());
    expect(Object.keys(changeEventSchemas).sort()).toEqual([...CHANGE_RESOURCES].sort());
    for (const resource of CHANGE_RESOURCES) {
      const event = sample(resource);
      expect(changeEventSchemas[resource].parse(event)).toEqual(event);
      expect(parseChangeEvent(event)).toEqual(event);
    }
  });

  it("lets events carry IDs only", () => {
    for (const resource of CHANGE_RESOURCES) {
      const fields = Object.keys(changeEventSchemas[resource].shape);
      expect(fields.filter((field) => !ALLOWED_FIELDS.has(field))).toEqual([]);
      for (const extra of ["title", "body", "payload", "name", "userName", "reason", "error"]) {
        expect(changeEventSchema.safeParse({ ...sample(resource), [extra]: "x" }).success).toBe(
          false,
        );
      }
      // IDs are IDs, not free text.
      expect(
        changeEventSchema.safeParse({ ...sample(resource), ids: ["Fix the login bug"] }).success,
      ).toBe(false);
      expect(changeEventSchema.safeParse({ ...sample(resource), ids: [] }).success).toBe(false);
    }
    expect(
      changeEventSchema.safeParse({ ...sample("settings"), section: "Ada's settings" }).success,
    ).toBe(false);
  });

  it("rejects unknown resources and versions", () => {
    expect(parseChangeEvent({ ...sample("run"), resource: "job" })).toBeNull();
    expect(parseChangeEvent({ ...sample("run"), v: 2 })).toBeNull();
    expect(parseChangeEvent("run")).toBeNull();
  });
});

describe("change channels", () => {
  it("are per organization and per user", () => {
    expect(orgChangesChannel(ORG)).toBe(`org:${ORG}:changes`);
    expect(userChangesChannel(ID)).toBe(`user:${ID}:changes`);
  });

  it("never equal an agent's wake channel", () => {
    for (const id of [ID, ORG]) {
      const wake = [orgWakeChannel(id), harnessWakeChannel(id)];
      expect(wake).not.toContain(orgChangesChannel(id));
      expect(wake).not.toContain(userChangesChannel(id));
    }
    expect(orgWakeChannel(ORG)).toBe(`org:${ORG}`);
    expect(harnessWakeChannel(ID)).toBe(`harness:${ID}`);
  });
});
