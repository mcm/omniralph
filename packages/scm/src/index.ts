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
