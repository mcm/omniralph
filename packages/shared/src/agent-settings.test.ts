import { describe, expect, it } from "vitest";
import {
  AgentLocalSettings,
  AllowListSettingsBody,
  CapacitySettingsBody,
  DEFAULT_MAX_CONCURRENCY,
  HostToolsSettingsBody,
  KindsSettingsBody,
  LOCAL_SETTINGS_SECTION_BODIES,
  LOCAL_SETTINGS_SECTIONS,
  LocalSettingsRevision,
  VersionSettingsBody,
  applyLocalSettingsSection,
  effectiveLocalSettings,
  installableAllowed,
} from "./agent-settings.js";
import { PackagePattern } from "./protocol.js";

const REVISION = "a".repeat(64);

function issues(value: unknown): string[] {
  const parsed = AgentLocalSettings.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
}

describe("AgentLocalSettings", () => {
  it("accepts an empty file and every key set", () => {
    expect(issues({ v: 1 })).toEqual([]);
    expect(
      issues({
        v: 1,
        maxConcurrency: 8,
        poolLimits: { long: 8, short: 2 },
        acceptedTaskTypes: ["review", "coding"],
        hostTools: { gh: "/usr/bin/gh", "open-grep.2": "/opt/bin/opengrep" },
        installables: { allow: ["@omniralph/*", "semgrep-mcp"] },
        update: { pin: "2.0.3" },
      }),
    ).toEqual([]);
    expect(issues({ v: 1, update: { pin: null }, installables: {} })).toEqual([]);
  });

  it("requires v: 1", () => {
    expect(issues({})).toEqual(["v"]);
    expect(issues({ v: 2 })).toEqual(["v"]);
  });

  it.each([0, 33, 2.5, "5"])("rejects maxConcurrency %j", (maxConcurrency) => {
    expect(issues({ v: 1, maxConcurrency })).toEqual(["maxConcurrency"]);
  });

  it("accepts maxConcurrency 1 and 32", () => {
    expect(issues({ v: 1, maxConcurrency: 1 })).toEqual([]);
    expect(issues({ v: 1, maxConcurrency: 32 })).toEqual([]);
  });

  it("rejects a pool limit above maxConcurrency, or the default one", () => {
    expect(issues({ v: 1, maxConcurrency: 3, poolLimits: { long: 4 } })).toEqual([
      "poolLimits.long",
    ]);
    expect(issues({ v: 1, maxConcurrency: 3, poolLimits: { short: 3, long: 3 } })).toEqual([]);
    expect(issues({ v: 1, poolLimits: { short: DEFAULT_MAX_CONCURRENCY + 1 } })).toEqual([
      "poolLimits.short",
    ]);
    expect(issues({ v: 1, poolLimits: { short: 0 } })).toEqual(["poolLimits.short"]);
    expect(issues({ v: 1, poolLimits: { gpu: 1 } })).toEqual(["poolLimits"]);
  });

  it.each([[], ["system"], ["review", "review"], "review"])(
    "rejects the accepted task types %j",
    (acceptedTaskTypes) => {
      expect(issues({ v: 1, acceptedTaskTypes })[0]).toMatch(/^acceptedTaskTypes/);
    },
  );

  it("rejects a relative host tool path and a bad host tool name", () => {
    expect(issues({ v: 1, hostTools: { gh: "bin/gh" } })).toEqual(["hostTools.gh"]);
    expect(issues({ v: 1, hostTools: { "Bad Name": "/usr/bin/x" } })[0]).toMatch(/^hostTools/);
  });

  it.each(["1.9.9", "0.8.0", "latest", "v2.0.4"])("rejects the pin %j", (pin) => {
    expect(new Set(issues({ v: 1, update: { pin } }))).toEqual(new Set(["update.pin"]));
  });

  it("accepts a pin of 2.0.0 or later", () => {
    expect(issues({ v: 1, update: { pin: "2.0.0" } })).toEqual([]);
    expect(issues({ v: 1, update: { pin: "2.1.0-beta.1" } })).toEqual([]);
  });

  it("rejects unknown keys at every level", () => {
    expect(issues({ v: 1, server: "https://x" })).toEqual([""]);
    expect(issues({ v: 1, installables: { allow: [], registry: "x" } })).toEqual(["installables"]);
    expect(issues({ v: 1, update: { pin: "2.0.0", channel: "beta" } })).toEqual(["update"]);
  });

  it.each(["", " ", "@a/ b", "@a/b/c", "a//b"])("rejects the package pattern %j", (pattern) => {
    expect(PackagePattern.safeParse(pattern).success).toBe(false);
    expect(issues({ v: 1, installables: { allow: [pattern] } })).toEqual(["installables.allow.0"]);
  });
});

describe("effectiveLocalSettings", () => {
  it("fills in every default", () => {
    expect(effectiveLocalSettings({ v: 1 })).toEqual({
      maxConcurrency: 5,
      poolLimits: { long: 4, short: 5 },
      acceptedTaskTypes: ["query", "review", "coding"],
      hostTools: {},
      installablesAllow: ["@omniralph/*"],
      versionPin: null,
    });
  });

  it("derives the default pool limits from the slots", () => {
    expect(effectiveLocalSettings({ v: 1, maxConcurrency: 1 }).poolLimits).toEqual({
      long: 1,
      short: 1,
    });
    expect(
      effectiveLocalSettings({ v: 1, maxConcurrency: 8, poolLimits: { short: 2 } }).poolLimits,
    ).toEqual({ long: 7, short: 2 });
  });

  it("keeps what is set, with the task types in their usual order", () => {
    expect(
      effectiveLocalSettings({
        v: 1,
        maxConcurrency: 3,
        poolLimits: { long: 3, short: 1 },
        acceptedTaskTypes: ["coding", "query"],
        hostTools: { gh: "/usr/bin/gh" },
        installables: { allow: [] },
        update: { pin: "2.0.3" },
      }),
    ).toEqual({
      maxConcurrency: 3,
      poolLimits: { long: 3, short: 1 },
      acceptedTaskTypes: ["query", "coding"],
      hostTools: { gh: "/usr/bin/gh" },
      installablesAllow: [],
      versionPin: "2.0.3",
    });
  });
});

describe("installableAllowed", () => {
  it("matches names and * patterns, never across /", () => {
    const allow = ["semgrep-mcp", "@acme/*", "@x/tool-*", "a.b"];
    expect(installableAllowed(allow, "semgrep-mcp")).toBe(true);
    expect(installableAllowed(allow, "semgrep-mcp-extra")).toBe(false);
    expect(installableAllowed(allow, "@acme/anything")).toBe(true);
    expect(installableAllowed(allow, "@acme2/anything")).toBe(false);
    expect(installableAllowed(allow, "@acme/a/b")).toBe(false);
    expect(installableAllowed(allow, "@x/tool-graph")).toBe(true);
    expect(installableAllowed(allow, "@x/other")).toBe(false);
    expect(installableAllowed(allow, "axb")).toBe(false);
    expect(installableAllowed([], "@omniralph/x")).toBe(false);
  });
});

describe("section bodies", () => {
  it("has a body schema per section", () => {
    expect(Object.keys(LOCAL_SETTINGS_SECTION_BODIES)).toEqual([...LOCAL_SETTINGS_SECTIONS]);
  });

  it("needs a revision", () => {
    expect(LocalSettingsRevision.safeParse("none").success).toBe(true);
    expect(LocalSettingsRevision.safeParse(REVISION).success).toBe(true);
    expect(LocalSettingsRevision.safeParse("abc").success).toBe(false);
    expect(KindsSettingsBody.safeParse({ acceptedTaskTypes: ["review"] }).success).toBe(false);
  });

  it("validates each body like the file", () => {
    const capacity = {
      revision: REVISION,
      maxConcurrency: 4,
      poolLimits: { long: null, short: 2 },
    };
    expect(CapacitySettingsBody.safeParse(capacity).success).toBe(true);
    expect(CapacitySettingsBody.safeParse({ ...capacity, maxConcurrency: 33 }).success).toBe(false);
    expect(KindsSettingsBody.safeParse({ revision: REVISION, acceptedTaskTypes: [] }).success).toBe(
      false,
    );
    expect(
      HostToolsSettingsBody.safeParse({ revision: REVISION, hostTools: { gh: "gh" } }).success,
    ).toBe(false);
    expect(AllowListSettingsBody.safeParse({ revision: REVISION, allow: ["a b"] }).success).toBe(
      false,
    );
    expect(VersionSettingsBody.safeParse({ revision: REVISION, pin: "1.0.0" }).success).toBe(false);
    expect(VersionSettingsBody.safeParse({ revision: REVISION, pin: null, extra: 1 }).success).toBe(
      false,
    );
  });
});

describe("applyLocalSettingsSection", () => {
  const base: AgentLocalSettings = {
    v: 1,
    maxConcurrency: 6,
    poolLimits: { long: 3 },
    hostTools: { gh: "/usr/bin/gh" },
    update: { pin: "2.0.3" },
  };

  it("replaces one section and leaves the rest", () => {
    expect(
      applyLocalSettingsSection(base, "capacity", {
        maxConcurrency: null,
        poolLimits: { long: null, short: null },
      }),
    ).toEqual({ v: 1, hostTools: { gh: "/usr/bin/gh" }, update: { pin: "2.0.3" } });
    expect(applyLocalSettingsSection(base, "kinds", { acceptedTaskTypes: ["review"] })).toEqual({
      ...base,
      acceptedTaskTypes: ["review"],
    });
    expect(applyLocalSettingsSection(base, "host-tools", { hostTools: {} })).toEqual({
      v: 1,
      maxConcurrency: 6,
      poolLimits: { long: 3 },
      update: { pin: "2.0.3" },
    });
    expect(applyLocalSettingsSection(base, "allow-list", { allow: [] })).toEqual({
      ...base,
      installables: { allow: [] },
    });
    expect(applyLocalSettingsSection(base, "version", { pin: null })).toEqual({
      v: 1,
      maxConcurrency: 6,
      poolLimits: { long: 3 },
      hostTools: { gh: "/usr/bin/gh" },
    });
    expect(base.update).toEqual({ pin: "2.0.3" });
  });

  it("treats a left-out capacity value or kinds list as the default", () => {
    expect(CapacitySettingsBody.safeParse({ revision: "none" }).success).toBe(true);
    expect(KindsSettingsBody.safeParse({ revision: "none" }).success).toBe(true);
    expect(applyLocalSettingsSection(base, "capacity", {})).toEqual({
      v: 1,
      hostTools: { gh: "/usr/bin/gh" },
      update: { pin: "2.0.3" },
    });
    expect(
      applyLocalSettingsSection(base, "capacity", { maxConcurrency: 4, poolLimits: { short: 2 } }),
    ).toEqual({ ...base, maxConcurrency: 4, poolLimits: { short: 2 } });
    expect(
      applyLocalSettingsSection({ ...base, acceptedTaskTypes: ["review"] }, "kinds", {}),
    ).toEqual(base);
  });

  it("leaves validation to the schema", () => {
    const next = applyLocalSettingsSection(base, "capacity", {
      maxConcurrency: 2,
      poolLimits: { long: 3, short: null },
    });
    expect(AgentLocalSettings.safeParse(next).success).toBe(false);
  });
});
