/**
 * Installable skills in sessions. Claude Code only loads skills from settings
 * (`~/.claude`, the repository's `.claude/`) or plugins, and sessions that
 * load no settings must stay that way, so each installable's skills go into
 * a plugin the agent writes itself: `<dataDir>/skill-plugins/<plugin>-<hash>/`
 * with a `.claude-plugin/plugin.json` and a copy of each skill under
 * `skills/<skill>/` (nothing else from the package: no hooks, agents,
 * commands or MCP config). The directory is keyed by a hash of the skills'
 * contents, so it is written once per version of them and never changes
 * under a running session.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import type { SessionPermissions } from "@omniralph/engine";

export const SKILL_PLUGINS_DIR = "skill-plugins";

/** The file a skill directory must have (Claude Code's skill format). */
const SKILL_FILE = "SKILL.md";
/** Skill names Claude Code accepts in a session's `skills` list (no parentheses, commas, spaces). */
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The skills a run's sessions load: one plugin per installable, and the skills to enable. */
export interface InstallableSkills {
  plugins: SdkPluginConfig[];
  /** Plugin-qualified skill names (`<plugin>:<skill>`). */
  skills: string[];
}

/** An installable's skill plugin, written by `installableSkillPlugin`. */
export interface InstallableSkillPlugin {
  /** The plugin's name, which qualifies its skills. */
  name: string;
  /** The plugin directory. */
  path: string;
  /** Plugin-qualified skill names (`<plugin>:<skill>`), in manifest order. */
  skills: string[];
}

/**
 * The plugin name of an installable's skills: its package name, lowercase,
 * with each run of other characters than letters and digits replaced by `-`
 * (`@omniralph/code-graph` → `omniralph-code-graph`), so its skills are
 * `omniralph-code-graph:<skill>`.
 */
export function installableSkillPluginName(installable: string): string {
  return installable
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface SkillFile {
  /** Path inside the skill's directory, `/`-separated. */
  rel: string;
  abs: string;
}

interface Skill {
  name: string;
  files: SkillFile[];
}

/** Every regular file under `dir` (symbolic links followed), sorted by relative path. */
async function walk(dir: string, prefix = ""): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  for (const entry of (await readdir(dir)).sort()) {
    const abs = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const info = await stat(abs);
    if (info.isDirectory()) files.push(...(await walk(abs, rel)));
    else if (info.isFile()) files.push({ rel, abs });
  }
  return files;
}

/**
 * A manifest skill path: a directory with a `SKILL.md` (named after the
 * directory, all its files copied), or a Markdown file (named after the file,
 * or its directory for a `SKILL.md`, copied as the skill's `SKILL.md`).
 */
async function readSkill(installable: string, skillPath: string): Promise<Skill> {
  const fail = (why: string) =>
    new Error(`the skill ${skillPath} of the installable ${installable} ${why}`);
  const info = await stat(skillPath).catch(() => null);
  let skill: Skill;
  if (info?.isDirectory()) {
    const files = await walk(skillPath);
    if (!files.some((f) => f.rel === SKILL_FILE)) throw fail(`has no ${SKILL_FILE}`);
    skill = { name: path.basename(skillPath), files };
  } else if (info?.isFile()) {
    const base = path.basename(skillPath);
    if (!base.toLowerCase().endsWith(".md")) throw fail("is not a Markdown file");
    const name = base === SKILL_FILE ? path.basename(path.dirname(skillPath)) : base.slice(0, -3);
    skill = { name, files: [{ rel: SKILL_FILE, abs: skillPath }] };
  } else {
    throw fail("does not exist");
  }
  if (!SKILL_NAME_PATTERN.test(skill.name)) throw fail(`has an invalid name: ${skill.name}`);
  return skill;
}

/**
 * Writes (once) the plugin holding an installable's skills, given their
 * absolute paths in the installed package (`resolveInstallablePaths`); null
 * when it has none. Throws for a skill path that is missing or not a skill,
 * an invalid skill name or two skills with one name.
 */
export async function installableSkillPlugin(
  dataDir: string,
  installable: string,
  skillPaths: readonly string[],
): Promise<InstallableSkillPlugin | null> {
  if (skillPaths.length === 0) return null;
  const name = installableSkillPluginName(installable);
  const skills: Skill[] = [];
  for (const skillPath of skillPaths) {
    const skill = await readSkill(installable, skillPath);
    if (skills.some((s) => s.name === skill.name)) {
      throw new Error(`the installable ${installable} has two skills named ${skill.name}`);
    }
    skills.push(skill);
  }

  const hash = createHash("sha256").update(`${name}\0`);
  const contents = new Map<string, Buffer>();
  for (const skill of skills) {
    for (const file of skill.files) {
      const content = await readFile(file.abs);
      const target = `${skill.name}/${file.rel}`;
      contents.set(target, content);
      hash.update(`${target}\0${content.length}\0`).update(content);
    }
  }
  const dir = path.join(dataDir, SKILL_PLUGINS_DIR, `${name}-${hash.digest("hex").slice(0, 16)}`);
  const result = { name, path: dir, skills: skills.map((s) => `${name}:${s.name}`) };
  if (await stat(path.join(dir, ".claude-plugin", "plugin.json")).catch(() => null)) return result;

  // Written next to it and renamed into place, so a concurrent run never sees half of it.
  const tmp = `${dir}.tmp-${randomUUID()}`;
  try {
    await mkdir(path.join(tmp, ".claude-plugin"), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(tmp, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name, description: `Skills of the installable ${installable}` }, null, 2)}\n`,
    );
    for (const [target, content] of contents) {
      const file = path.join(tmp, "skills", ...target.split("/"));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    await rename(tmp, dir).catch(async (error: NodeJS.ErrnoException) => {
      // Another run wrote the same plugin first.
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return result;
}

/**
 * A session's permissions with a run's installable skills: their plugins
 * (MCP discovery off: the agent attaches an installable's MCP servers
 * itself), the `Skill` tool when the session has an explicit tool list, and,
 * when the session enables only listed skills (no settings loaded), those
 * skills too. A session without tools gets none.
 */
export function withInstallableSkills(
  permissions: SessionPermissions,
  skills: InstallableSkills | null | undefined,
): SessionPermissions {
  if (!skills || skills.plugins.length === 0) return permissions;
  const tools = permissions.tools;
  if (Array.isArray(tools) && tools.length === 0) return permissions;
  return {
    ...permissions,
    ...(Array.isArray(tools) && !tools.includes("Skill") && { tools: [...tools, "Skill"] }),
    plugins: [...(permissions.plugins ?? []), ...skills.plugins],
    ...(Array.isArray(permissions.skills) && {
      skills: [...permissions.skills, ...skills.skills],
    }),
  };
}
