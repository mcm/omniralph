export const packageName = "@omniralph/scm";

export * from "./types.js";
export { buildDiffLineIndex, isCommentInDiff, parsePatchLines } from "./diff-lines.js";
export type { CommentableLines, DiffLineIndex } from "./diff-lines.js";
export { capLength, fencedBlock, renderInlineComment, summaryWithFallbacks } from "./comment-body.js";
export {
  APP_JWT_TTL_SECONDS,
  createAppJwtSigner,
  KmsAppJwtSigner,
  PemAppJwtSigner,
} from "./github/app-jwt.js";
export type { AppJwt, AppJwtSigner } from "./github/app-jwt.js";
export { GitHubAppAuth, GITHUB_API_URL } from "./github/app-auth.js";
export type {
  GitHubAppAuthOptions,
  InstallationPermissions,
  InstallationToken,
  InstallationTokenScope,
} from "./github/app-auth.js";
export { GitHubAdapter, splitRepoPath } from "./github/adapter.js";
export type { GitHubAdapterOptions } from "./github/adapter.js";
export { MemoryCredentialCache } from "./credential-cache.js";
export type { CachedCredential, CredentialCache } from "./credential-cache.js";
export {
  CLONE_TOKEN_ROTATE_MS,
  GITLAB_URL,
  GitLabAdapter,
  READ_REPOSITORY_SCOPE,
  renderGitLabComment,
} from "./gitlab/adapter.js";
export type { GitLabAdapterOptions } from "./gitlab/adapter.js";
export { buildGitLabDiffIndex, buildPosition, lineCode, parseFileLines } from "./gitlab/positions.js";
export type { DiffRefs, GitLabDiffFile, GitLabDiffIndex, TextPosition } from "./gitlab/positions.js";
export { GitLabSetupClient, GitLabSetupError, normalizeGitLabUrl } from "./gitlab/setup.js";
export type { GitLabHookOptions, GitLabProject, GitLabTokenOwner } from "./gitlab/setup.js";
export { appInstallUrl, getAppSlug, getInstallation, listInstallationRepos } from "./github/installations.js";
export type { GitHubInstallation, GitHubInstallationRepo } from "./github/installations.js";
