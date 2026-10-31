import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { normalizeKey, type ShortcutDefinition } from "@omniralph/ui";
import { describe, expect, it } from "vitest";
import { NAV_SHORTCUTS } from "@/components/app-shortcuts";
import { navItems } from "./navigation";
import { SHORTCUTS, type ShortcutId } from "./shortcuts";

const WEB_SRC = path.resolve(__dirname, "..");
const UI_SRC = path.resolve(WEB_SRC, "../../../packages/ui/src");

/** The key events a definition answers: its normalized key, and whether Mod is held. */
const eventOf = (definition: Pick<ShortcutDefinition, "key" | "mod">) =>
  `${definition.mod ? "Mod+" : ""}${normalizeKey(definition.key)}`;

/** Each key event that more than one definition answers, with the ids answering it. */
function conflicts(definitions: Record<string, Pick<ShortcutDefinition, "key" | "mod">>) {
  const byEvent = new Map<string, string[]>();
  for (const [id, definition] of Object.entries(definitions)) {
    const event = eventOf(definition);
    byEvent.set(event, [...(byEvent.get(event) ?? []), id]);
  }
  return [...byEvent].filter(([, ids]) => ids.length > 1);
}

/** Whether `key` is one `event.key` value: a character, or a key name such as "Escape". */
const isOneKey = (key: unknown) => typeof key === "string" && /^(?:.|[A-Z][A-Za-z]+)$/u.test(key);

/** The browser keeps these Mod chords (new tab, close, new window, location, reload, quit). */
const BROWSER_MOD_KEYS = ["t", "w", "n", "l", "r", "q", "Tab"];
/** Plain keys that scroll, activate or move focus. */
const RESERVED_PLAIN_KEYS = [
  " ",
  "Enter",
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
];

function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => path.join(dir, file));
}

const ALL_SOURCES = [...sources(WEB_SRC), ...sources(UI_SRC)];
const relative = (file: string) => path.relative(path.resolve(WEB_SRC, "../../.."), file);

const entries = Object.entries(SHORTCUTS) as [ShortcutId, ShortcutDefinition][];

describe("SHORTCUTS", () => {
  it("has 25 actions, each with one key that no other action answers", () => {
    expect(entries).toHaveLength(25);
    expect(entries.filter(([, definition]) => !isOneKey(definition.key))).toEqual([]);
    expect(conflicts(SHORTCUTS)).toEqual([]);
  });

  it("finds a conflict in a fixture, by normalized key and Mod", () => {
    expect(
      conflicts({
        listNext: { key: "j" },
        other: { key: "J" },
        ask: { key: "j", mod: true },
        escape: { key: "Escape" },
        esc: { key: "Esc" },
      }),
    ).toEqual([
      ["j", ["listNext", "other"]],
      ["Escape", ["escape", "esc"]],
    ]);
    expect(isOneKey(["j", "k"])).toBe(false);
    expect(isOneKey("j,k")).toBe(false);
  });

  it("fires in fields only for Close, and repeats only for Next and Previous item", () => {
    expect(entries.filter(([, definition]) => definition.allowInFields).map(([id]) => id)).toEqual([
      "close",
    ]);
    expect(entries.filter(([, definition]) => definition.repeat).map(([id]) => id)).toEqual([
      "listNext",
      "listPrevious",
    ]);
  });

  it("uses no Mod chord the browser keeps and no plain key that scrolls or moves focus", () => {
    const kept = new Set(BROWSER_MOD_KEYS.map(normalizeKey));
    expect(
      entries.filter(([, definition]) => definition.mod && kept.has(normalizeKey(definition.key))),
    ).toEqual([]);
    expect(
      entries.filter(
        ([, definition]) => !definition.mod && RESERVED_PLAIN_KEYS.includes(definition.key),
      ),
    ).toEqual([]);
  });

  it("gives the Go to digits in the nav's order, Ask skipped, each to an entry whose page exists", () => {
    const goIds = entries.map(([id]) => id).filter((id) => id.startsWith("go"));
    const navOrder = navItems
      .map((item) => NAV_SHORTCUTS[item.id as keyof typeof NAV_SHORTCUTS])
      .filter((id) => id !== "ask");
    expect(goIds).toEqual(navOrder);
    expect(goIds.map((id) => SHORTCUTS[id].key)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    for (const item of navItems) {
      const page = path.join(WEB_SRC, "app/(app)", item.href, "page.tsx");
      expect(existsSync(page), item.href).toBe(true);
    }
    expect(Object.keys(NAV_SHORTCUTS).sort()).toEqual(navItems.map((item) => item.id).sort());
  });

  it("has a control registering every action (useShortcut, or a nav entry's keys)", () => {
    const registering = ALL_SOURCES.filter(
      (file) => !file.endsWith(path.join("lib", "shortcuts.ts")),
    )
      .map((file) => readFileSync(file, "utf8"))
      .filter((source) => /\buseShortcut\(/.test(source));
    const unused = entries
      .map(([id]) => id)
      .filter((id) => !registering.some((source) => source.includes(`"${id}"`)));
    expect(unused).toEqual([]);
  });
});

describe("one listener", () => {
  it("adds no document- or window-level keydown listener outside the engine", () => {
    const engine = path.join(UI_SRC, "shortcuts") + path.sep;
    // Audio unlock: browsers allow sound only after a gesture, and keydown is one; it reads
    // no key and prevents nothing, so it's not a shortcut.
    const audioUnlock = path.join(WEB_SRC, "components", "sound-provider.tsx");
    const offenders = ALL_SOURCES.filter(
      (file) =>
        !file.startsWith(engine) &&
        file !== audioUnlock &&
        /\b(?:window|document|ownerDocument)\s*\.\s*addEventListener\(\s*["']keydown["']/.test(
          readFileSync(file, "utf8"),
        ),
    ).map(relative);
    expect(offenders).toEqual([]);
  });
});

describe("shortcut hints", () => {
  it("renders <kbd> only in the Help view", () => {
    const offenders = ALL_SOURCES.filter(
      (file) => file.endsWith(".tsx") && /<kbd\b/.test(readFileSync(file, "utf8")),
    ).map(relative);
    expect(offenders).toEqual(["apps/web/src/screens/help/help-view.tsx"]);
  });
});
