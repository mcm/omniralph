export * from "./schema.js";
export { createDb, type Database } from "./client.js";
export { runMigrations, migrationsFolder } from "./migrate.js";
export { decrypt, encrypt, hashToken, parseEncryptionKey } from "./crypto.js";
export {
  addAllowedEmail,
  countAdmins,
  createUserWithInitialRole,
  deleteAllowedEmail,
  deleteUser,
  getUserById,
  initialUserRole,
  isEmailAllowlisted,
  listAllowedEmails,
  listUsers,
  normalizeEmail,
  setUserRole,
  type AllowedEmail,
  type NewUser,
  type User,
  type UserRole,
} from "./users.js";
export {
  createScmCredentialCache,
  getScmCredential,
  saveScmCredential,
  type ScmCredential,
  type ScmRepoRef,
} from "./scm-credentials.js";
export {
  connectionCredentials,
  connectRepository,
  disconnectRepository,
  findScmConnection,
  getRepository,
  getScmConnection,
  listConnectionRepositories,
  listRepositoryOverview,
  listScmConnections,
  setRepositoryEnabled,
  upsertScmConnection,
  type ConnectRepositoryInput,
  type Repository,
  type RepositoryOverview,
  type ScmConnection,
  type ScmConnectionInput,
  type ScmProvider,
} from "./repositories.js";
