import { Database } from "bun:sqlite";
import { resolve } from "path";
import { logger } from "./logger";
import { ensureDataDir } from "./paths";
import { getConfig } from "./config";

const dataDir = ensureDataDir();
const dbPath = resolve(dataDir, "overlord.db");
const db = new Database(dbPath);

export type UserRole = "admin" | "operator" | "viewer";
export type ClientAccessScope = "none" | "allowlist" | "denylist" | "all";
export type ClientAccessRuleKind = "allow" | "deny";

export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: UserRole;
  created_at: number;
  last_login: number | null;
  created_by: string | null;
  must_change_password: number;
  client_scope: ClientAccessScope;
  can_build: number;
  telegram_chat_id: string | null;
}

export interface UserInfo {
  id: number;
  username: string;
  role: UserRole;
  created_at: number;
  last_login: number | null;
  created_by: string | null;
  client_scope: ClientAccessScope;
  can_build: number;
  telegram_chat_id: string | null;
}

export interface UserClientAccessRule {
  userId: number;
  clientId: string;
  access: ClientAccessRuleKind;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'viewer')),
    created_at INTEGER NOT NULL,
    last_login INTEGER,
    created_by TEXT,
    must_change_password INTEGER DEFAULT 0,
    client_scope TEXT NOT NULL DEFAULT 'none' CHECK(client_scope IN ('none', 'allowlist', 'denylist', 'all'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_client_access_rules (
    user_id INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    access TEXT NOT NULL CHECK(access IN ('allow', 'deny')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, client_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);

db.exec(
  `CREATE INDEX IF NOT EXISTS idx_user_client_access_rules_user ON user_client_access_rules(user_id)`,
);

try {
  db.exec(
    `ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0`,
  );
  logger.info("[users] Added must_change_password column to existing database");
} catch (err: any) {
  if (!err.message?.includes("duplicate column name")) {
    logger.error("[users] Migration error:", err);
  }
}

try {
  db.exec(
    `ALTER TABLE users ADD COLUMN client_scope TEXT NOT NULL DEFAULT 'none' CHECK(client_scope IN ('none', 'allowlist', 'denylist', 'all'))`,
  );
  logger.info("[users] Added client_scope column to existing database");
} catch (err: any) {
  if (!err.message?.includes("duplicate column name")) {
    logger.error("[users] Migration error:", err);
  }
}

try {
  db.exec(`UPDATE users SET client_scope='all' WHERE role='admin'`);
} catch (err: any) {
  logger.error("[users] Failed to normalize admin client_scope:", err);
}

try {
  db.exec(
    `ALTER TABLE users ADD COLUMN can_build INTEGER NOT NULL DEFAULT 0`,
  );
  logger.info("[users] Added can_build column to existing database");

  try {
    db.exec(`UPDATE users SET can_build=1 WHERE role='admin' OR role='operator'`);
  } catch (err: any) {
    logger.error("[users] Failed to backfill admin/operator can_build:", err);
  }
} catch (err: any) {
  if (!err.message?.includes("duplicate column name")) {
    logger.error("[users] Migration error:", err);
  }
}

try {
  db.exec(
    `ALTER TABLE users ADD COLUMN telegram_chat_id TEXT DEFAULT NULL`,
  );
  logger.info("[users] Added telegram_chat_id column to existing database");
} catch (err: any) {
  if (!err.message?.includes("duplicate column name")) {
    logger.error("[users] Migration error:", err);
  }
}

const notificationColumns: Array<{ sql: string; label: string }> = [
  { sql: `ALTER TABLE users ADD COLUMN webhook_enabled INTEGER DEFAULT 0`, label: "webhook_enabled" },
  { sql: `ALTER TABLE users ADD COLUMN webhook_url TEXT DEFAULT NULL`, label: "webhook_url" },
  { sql: `ALTER TABLE users ADD COLUMN webhook_template TEXT DEFAULT NULL`, label: "webhook_template" },
  { sql: `ALTER TABLE users ADD COLUMN telegram_enabled INTEGER DEFAULT 0`, label: "telegram_enabled" },
  { sql: `ALTER TABLE users ADD COLUMN telegram_bot_token TEXT DEFAULT NULL`, label: "telegram_bot_token" },
  { sql: `ALTER TABLE users ADD COLUMN telegram_template TEXT DEFAULT NULL`, label: "telegram_template" },
];
for (const col of notificationColumns) {
  try {
    db.exec(col.sql);
    logger.info(`[users] Added ${col.label} column to existing database`);
  } catch (err: any) {
    if (!err.message?.includes("duplicate column name")) {
      logger.error("[users] Migration error:", err);
    }
  }
}

const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get() as {
  count: number;
};
if (userCount.count === 0) {
  const config = getConfig();
  const initialUsername = (config.auth.username || "admin").trim() || "admin";
  const initialPassword = config.auth.password;

  logger.info("[users] No users found, creating default admin account");
  const defaultPassword = await Bun.password.hash(initialPassword, {
    algorithm: "bcrypt",
    cost: 10,
  });

  db.prepare(
    "INSERT INTO users (username, password_hash, role, created_at, created_by, must_change_password, client_scope, can_build) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(initialUsername, defaultPassword, "admin", Date.now(), "system", 1, "all", 1);

  const createdUser = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(initialUsername) as User | undefined;
  logger.info(
    "[users] Default admin created with must_change_password =",
    createdUser?.must_change_password,
  );

  logger.info(`[users] Initial admin account created (username: ${initialUsername})`);
  logger.warn(
    `[users] Bootstrap login credentials -> username: ${initialUsername} | password: ${initialPassword}`,
  );
  logger.warn(
    "[users] SECURITY WARNING: Rotate the bootstrap password after first login. Default bootstrap credentials are admin/admin unless overridden by configuration.",
  );
}

export function getUserById(id: number): User | null {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
    | User
    | undefined;
  return user || null;
}

export function getUserByUsername(username: string): User | null {
  const user = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username) as User | undefined;
  return user || null;
}

export function listUsers(): UserInfo[] {
  const users = db
    .prepare(
      "SELECT id, username, role, created_at, last_login, created_by, client_scope, can_build, telegram_chat_id FROM users ORDER BY created_at DESC",
    )
    .all() as UserInfo[];
  return users;
}

export function getUserClientAccessScope(userId: number): ClientAccessScope {
  const row = db
    .prepare("SELECT client_scope FROM users WHERE id = ?")
    .get(userId) as { client_scope?: ClientAccessScope } | undefined;
  return row?.client_scope || "none";
}

export function listUserClientAccessRules(userId: number): UserClientAccessRule[] {
  return db
    .prepare(
      "SELECT user_id as userId, client_id as clientId, access FROM user_client_access_rules WHERE user_id = ? ORDER BY client_id ASC",
    )
    .all(userId) as UserClientAccessRule[];
}

export function listUserClientRuleIdsByAccess(
  userId: number,
  access: ClientAccessRuleKind,
): string[] {
  return db
    .prepare(
      "SELECT client_id as clientId FROM user_client_access_rules WHERE user_id = ? AND access = ? ORDER BY client_id ASC",
    )
    .all(userId, access)
    .map((row: { clientId: string }) => row.clientId);
}

export function setUserClientAccessScope(
  userId: number,
  scope: ClientAccessScope,
): { success: boolean; error?: string } {
  if (!["none", "allowlist", "denylist", "all"].includes(scope)) {
    return { success: false, error: "Invalid client access scope" };
  }

  try {
    db.prepare("UPDATE users SET client_scope = ? WHERE id = ?").run(scope, userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserClientAccessScope error:", err);
    return { success: false, error: err.message || "Failed to update client access scope" };
  }
}

export function setUserClientAccessRule(
  userId: number,
  clientId: string,
  access: ClientAccessRuleKind,
): { success: boolean; error?: string } {
  const normalizedClientId = (clientId || "").trim();
  if (!normalizedClientId) {
    return { success: false, error: "clientId is required" };
  }
  if (!["allow", "deny"].includes(access)) {
    return { success: false, error: "Invalid client access rule" };
  }

  try {
    db.prepare(
      "INSERT OR REPLACE INTO user_client_access_rules (user_id, client_id, access, created_at) VALUES (?, ?, ?, ?)",
    ).run(userId, normalizedClientId, access, Date.now());
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserClientAccessRule error:", err);
    return { success: false, error: err.message || "Failed to update client access rule" };
  }
}

export function removeUserClientAccessRule(
  userId: number,
  clientId: string,
): { success: boolean; error?: string } {
  try {
    db.prepare("DELETE FROM user_client_access_rules WHERE user_id = ? AND client_id = ?").run(
      userId,
      clientId,
    );
    return { success: true };
  } catch (err: any) {
    logger.error("[users] removeUserClientAccessRule error:", err);
    return { success: false, error: err.message || "Failed to remove client access rule" };
  }
}

export function canUserAccessClient(
  userId: number,
  role: UserRole,
  clientId: string,
): boolean {
  if (role === "admin") return true;

  const scope = getUserClientAccessScope(userId);
  if (scope === "none") return false;
  if (scope === "all") return true;

  const row = db
    .prepare(
      "SELECT access FROM user_client_access_rules WHERE user_id = ? AND client_id = ?",
    )
    .get(userId, clientId) as { access?: ClientAccessRuleKind } | undefined;

  if (scope === "allowlist") {
    return row?.access === "allow";
  }
  if (scope === "denylist") {
    return row?.access !== "deny";
  }
  return false;
}

function validatePasswordPolicy(password: string): string | null {
  const security = getConfig().security;
  const minLength = Math.min(128, Math.max(6, Number(security.passwordMinLength) || 6));

  if (!password || password.length < minLength) {
    return `Password must be at least ${minLength} characters`;
  }

  if (security.passwordRequireUppercase && !/[A-Z]/.test(password)) {
    return "Password must include at least one uppercase letter";
  }
  if (security.passwordRequireLowercase && !/[a-z]/.test(password)) {
    return "Password must include at least one lowercase letter";
  }
  if (security.passwordRequireNumber && !/[0-9]/.test(password)) {
    return "Password must include at least one number";
  }
  if (security.passwordRequireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    return "Password must include at least one symbol";
  }

  return null;
}

export async function createUser(
  username: string,
  password: string,
  role: UserRole,
  createdBy: string,
): Promise<{ success: boolean; error?: string; userId?: number }> {
  if (!username || username.length < 3 || username.length > 32) {
    return {
      success: false,
      error: "Username must be between 3 and 32 characters",
    };
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return {
      success: false,
      error:
        "Username can only contain letters, numbers, hyphens, and underscores",
    };
  }

  const policyError = validatePasswordPolicy(password);
  if (policyError) {
    return { success: false, error: policyError };
  }

  const existing = getUserByUsername(username);
  if (existing) {
    return { success: false, error: "Username already exists" };
  }

  try {
    const passwordHash = await Bun.password.hash(password, {
      algorithm: "bcrypt",
      cost: 10,
    });

    const result = db
      .prepare(
        "INSERT INTO users (username, password_hash, role, created_at, created_by, client_scope, can_build) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(username, passwordHash, role, Date.now(), createdBy, role === "admin" ? "all" : "none", role === "admin" || role === "operator" ? 1 : 0);

    return { success: true, userId: result.lastInsertRowid as number };
  } catch (err: any) {
    logger.error("[users] Create user error:", err);
    return { success: false, error: err.message || "Failed to create user" };
  }
}

export async function updateUserPassword(
  userId: number,
  newPassword: string,
): Promise<{ success: boolean; error?: string }> {
  const policyError = validatePasswordPolicy(newPassword);
  if (policyError) {
    return { success: false, error: policyError };
  }

  try {
    const passwordHash = await Bun.password.hash(newPassword, {
      algorithm: "bcrypt",
      cost: 10,
    });

    db.prepare(
      "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
    ).run(passwordHash, userId);
    return { success: true };
  } catch (err: any) {
    console.error("[users] Update password error:", err);
    return {
      success: false,
      error: err.message || "Failed to update password",
    };
  }
}

export function updateUserRole(
  userId: number,
  newRole: UserRole,
): { success: boolean; error?: string } {
  try {
    const nextScope: ClientAccessScope = newRole === "admin" ? "all" : "none";
    db.prepare("UPDATE users SET role = ?, client_scope = ? WHERE id = ?").run(
      newRole,
      nextScope,
      userId,
    );
    return { success: true };
  } catch (err: any) {
    console.error("[users] Update role error:", err);
    return { success: false, error: err.message || "Failed to update role" };
  }
}

export function deleteUser(userId: number): {
  success: boolean;
  error?: string;
} {
  const admins = db
    .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'")
    .get() as { count: number };
  const user = getUserById(userId);

  if (user?.role === "admin" && admins.count <= 1) {
    return { success: false, error: "Cannot delete the last admin user" };
  }

  try {
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    return { success: true };
  } catch (err: any) {
    console.error("[users] Delete user error:", err);
    return { success: false, error: err.message || "Failed to delete user" };
  }
}

export function updateLastLogin(userId: number): void {
  db.prepare("UPDATE users SET last_login = ? WHERE id = ?").run(
    Date.now(),
    userId,
  );
}

export async function verifyPassword(
  username: string,
  password: string,
): Promise<User | null> {
  const user = getUserByUsername(username);
  if (!user) return null;

  const isValid = await Bun.password.verify(password, user.password_hash);
  if (!isValid) return null;

  updateLastLogin(user.id);
  return user;
}

export function canManageUsers(role: UserRole): boolean {
  return role === "admin";
}

export function canControlClients(role: UserRole): boolean {
  return role === "admin" || role === "operator";
}

export function canViewClients(role: UserRole): boolean {
  return role === "admin";
}

export function canBuildClients(userId: number, role: UserRole): boolean {
  if (role === "admin") return true;
  const user = getUserById(userId);
  return user ? user.can_build === 1 : false;
}

export function canViewAuditLogs(role: UserRole): boolean {
  return role === "admin";
}

export function hasPermission(role: UserRole, permission: string, userId?: number): boolean {
  switch (permission) {
    case "users:manage":
      return canManageUsers(role);
    case "clients:control":
      return canControlClients(role);
    case "clients:view":
      return canViewClients(role);
    case "clients:build":
      if (userId !== undefined) return canBuildClients(userId, role);
      return role === "admin" || role === "operator";
    case "audit:view":
      return canViewAuditLogs(role);
    default:
      return false;
  }
}

export function setUserCanBuild(
  userId: number,
  canBuild: boolean,
): { success: boolean; error?: string } {
  try {
    db.prepare("UPDATE users SET can_build = ? WHERE id = ?").run(canBuild ? 1 : 0, userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserCanBuild error:", err);
    return { success: false, error: err.message || "Failed to update build permission" };
  }
}

export function setUserTelegramChatId(
  userId: number,
  chatId: string | null,
): { success: boolean; error?: string } {
  try {
    db.prepare("UPDATE users SET telegram_chat_id = ? WHERE id = ?").run(chatId, userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserTelegramChatId error:", err);
    return { success: false, error: err.message || "Failed to update Telegram chat ID" };
  }
}

export function getUserTelegramChatId(userId: number): string | null {
  const row = db
    .prepare("SELECT telegram_chat_id FROM users WHERE id = ?")
    .get(userId) as { telegram_chat_id?: string | null } | undefined;
  return row?.telegram_chat_id || null;
}

export function getUsersWithTelegramChatId(): Array<{ id: number; username: string; role: UserRole; client_scope: ClientAccessScope; telegram_chat_id: string }> {
  return db
    .prepare(
      "SELECT id, username, role, client_scope, telegram_chat_id FROM users WHERE telegram_chat_id IS NOT NULL AND telegram_chat_id != ''",
    )
    .all() as any[];
}

// ─── Per-user notification delivery settings ─────────────────────────────────

export interface UserNotificationSettings {
  webhook_enabled: number;
  webhook_url: string | null;
  webhook_template: string | null;
  telegram_enabled: number;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
  telegram_template: string | null;
}

export function getUserNotificationSettings(userId: number): UserNotificationSettings | null {
  const row = db
    .prepare(
      "SELECT webhook_enabled, webhook_url, webhook_template, telegram_enabled, telegram_bot_token, telegram_chat_id, telegram_template FROM users WHERE id = ?",
    )
    .get(userId) as UserNotificationSettings | undefined;
  return row ?? null;
}

export function updateUserNotificationSettings(
  userId: number,
  settings: Partial<UserNotificationSettings>,
): { success: boolean; error?: string } {
  const fields: string[] = [];
  const values: any[] = [];

  if ("webhook_enabled" in settings) {
    fields.push("webhook_enabled = ?");
    values.push(settings.webhook_enabled ? 1 : 0);
  }
  if ("webhook_url" in settings) {
    fields.push("webhook_url = ?");
    values.push(settings.webhook_url || null);
  }
  if ("webhook_template" in settings) {
    fields.push("webhook_template = ?");
    values.push(settings.webhook_template || null);
  }
  if ("telegram_enabled" in settings) {
    fields.push("telegram_enabled = ?");
    values.push(settings.telegram_enabled ? 1 : 0);
  }
  if ("telegram_bot_token" in settings) {
    fields.push("telegram_bot_token = ?");
    values.push(settings.telegram_bot_token || null);
  }
  if ("telegram_chat_id" in settings) {
    fields.push("telegram_chat_id = ?");
    values.push(settings.telegram_chat_id || null);
  }
  if ("telegram_template" in settings) {
    fields.push("telegram_template = ?");
    values.push(settings.telegram_template || null);
  }

  if (fields.length === 0) return { success: true };

  try {
    values.push(userId);
    db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] updateUserNotificationSettings error:", err);
    return { success: false, error: err.message || "Failed to update notification settings" };
  }
}

export interface UserDeliveryRow {
  id: number;
  username: string;
  role: UserRole;
  client_scope: ClientAccessScope;
  webhook_enabled: number;
  webhook_url: string | null;
  webhook_template: string | null;
  telegram_enabled: number;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
  telegram_template: string | null;
}

export function getUsersForNotificationDelivery(): UserDeliveryRow[] {
  return db
    .prepare(
      `SELECT id, username, role, client_scope,
              webhook_enabled, webhook_url, webhook_template,
              telegram_enabled, telegram_bot_token, telegram_chat_id, telegram_template
       FROM users
       WHERE (webhook_enabled = 1 AND webhook_url IS NOT NULL AND webhook_url != '')
          OR (telegram_enabled = 1 AND telegram_bot_token IS NOT NULL AND telegram_bot_token != ''
              AND telegram_chat_id IS NOT NULL AND telegram_chat_id != '')`,
    )
    .all() as UserDeliveryRow[];
}
