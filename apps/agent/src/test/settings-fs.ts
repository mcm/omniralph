import path from "node:path";
import { privateJsonText } from "../config.js";
import type { SettingsFs } from "../settings.js";

/**
 * An in-memory `SettingsFs` (works under fake timers): `files` holds each
 * file's text, `modes` the mode it was written with, and `handEdit` writes a
 * file as an editor would, notifying the watchers of its directory.
 */
export function memorySettingsFs() {
  const files = new Map<string, string>();
  const modes = new Map<string, number>();
  const watchers = new Set<{ dir: string; listener: (filename: string | null) => void }>();
  const notify = (file: string) => {
    for (const watcher of watchers) {
      if (watcher.dir === path.dirname(file)) watcher.listener(path.basename(file));
    }
  };
  const fs: SettingsFs = {
    readFile: async (file) => {
      const text = files.get(file);
      if (text === undefined) {
        throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
      }
      return Buffer.from(text);
    },
    writePrivateJson: async (file, value) => {
      files.set(file, privateJsonText(value));
      modes.set(file, 0o600);
      notify(file);
    },
    mkdir: async () => undefined,
    watch: (dir, listener) => {
      const watcher = { dir, listener };
      watchers.add(watcher);
      return { close: () => void watchers.delete(watcher) };
    },
  };
  return {
    fs,
    files,
    modes,
    /** How many watchers are open. */
    watching: () => watchers.size,
    handEdit(file: string, text: string | null) {
      if (text === null) files.delete(file);
      else files.set(file, text);
      notify(file);
    },
  };
}
