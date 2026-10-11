import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A private file holding a job's session token (`OMNIRALPH_JOB_TOKEN_FILE` in
 * `JobContext.sessionEnv()`), kept current as heartbeats refresh the token, so
 * long-lived session processes (e.g. the `git-credential` helper late in a
 * session) still authenticate. Created on first use; `close()` removes it.
 */
export class SessionTokenFile {
  private dir: string | undefined;
  private written: string | undefined;

  /** The file's path, writing `token` to it first if it changed. */
  path(token: string): string {
    this.dir ??= mkdtempSync(path.join(tmpdir(), "omniralph-session-token-"));
    const file = path.join(this.dir, "token");
    if (token !== this.written) {
      // Write-then-rename so a helper reading mid-refresh never sees a truncated file.
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, token, { mode: 0o600 });
      renameSync(tmp, file);
      this.written = token;
    }
    return file;
  }

  /** Rewrites the file with a refreshed token, if it exists. */
  update(token: string): void {
    if (this.dir) this.path(token);
  }

  close(): void {
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = undefined;
    this.written = undefined;
  }
}
