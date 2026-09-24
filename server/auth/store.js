import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const AUTH_SCHEMA_VERSION = 1

const SESSION_COOKIE_NAME_DEFAULT = 'workbench_session'

function nowIso() {
  return new Date().toISOString()
}

export function hashSessionToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

export function normalizeUsername(value) {
  return String(value ?? '')
    .trim()
    .replace(/^[^\\/]*\\/, '')
    .toLowerCase()
}

function publicUser(row) {
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name || row.username,
    email: row.email || null,
    role: row.role,
    last_login_at: row.last_login_at ?? null
  }
}

/**
 * Authentication state lives in its own SQLite file. It deliberately does not
 * participate in the business database's schema_migrations chain: sessions are
 * reconstructible state, and keeping them separate avoids coupling the V1-V13
 * migration ledger to authentication changes.
 */
export class ServerAuthStore {
  constructor(options = {}) {
    const databasePath = options.databasePath ?? ':memory:'
    this.databasePath = databasePath
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true })
    this.db = options.db ?? new DatabaseSync(databasePath)
    if (databasePath !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.#migrate()
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_users (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        ldap_dn       TEXT NOT NULL,
        display_name  TEXT,
        email         TEXT,
        role          TEXT NOT NULL DEFAULT 'member',
        is_active     INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id                  TEXT PRIMARY KEY,
        token_hash          TEXT NOT NULL UNIQUE,
        user_id             TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        created_at          TEXT NOT NULL,
        last_seen_at        TEXT NOT NULL,
        expires_at          TEXT NOT NULL,
        absolute_expires_at TEXT NOT NULL,
        revoked_at          TEXT,
        user_agent          TEXT,
        client_ip           TEXT
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);
    `)
    this.db
      .prepare('INSERT INTO auth_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
      .run('schema_version', String(AUTH_SCHEMA_VERSION))
  }

  upsertUser({ username, ldapDn, displayName, email }) {
    const normalized = normalizeUsername(username)
    if (!normalized || normalized.length > 200) throw new Error('invalid username')
    const timestamp = nowIso()
    const existing = this.db.prepare('SELECT * FROM auth_users WHERE username = ?').get(normalized)
    if (existing) {
      this.db
        .prepare(`
          UPDATE auth_users
             SET ldap_dn = ?, display_name = ?, email = ?, last_login_at = ?, updated_at = ?
           WHERE id = ?
        `)
        .run(
          String(ldapDn ?? '').slice(0, 1_024),
          displayName ? String(displayName).slice(0, 200) : null,
          email ? String(email).slice(0, 320) : null,
          timestamp,
          timestamp,
          existing.id
        )
      return publicUser(this.db.prepare('SELECT * FROM auth_users WHERE id = ?').get(existing.id))
    }
    const id = randomUUID()
    this.db
      .prepare(`
        INSERT INTO auth_users(id, username, ldap_dn, display_name, email, role, is_active, created_at, updated_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, 'member', 1, ?, ?, ?)
      `)
      .run(
        id,
        normalized,
        String(ldapDn ?? '').slice(0, 1_024),
        displayName ? String(displayName).slice(0, 200) : null,
        email ? String(email).slice(0, 320) : null,
        timestamp,
        timestamp,
        timestamp
      )
    return publicUser(this.db.prepare('SELECT * FROM auth_users WHERE id = ?').get(id))
  }

  findUserByUsername(username) {
    const row = this.db.prepare('SELECT * FROM auth_users WHERE username = ?').get(normalizeUsername(username))
    return row ? { ...publicUser(row), is_active: Number(row.is_active) !== 0 } : null
  }

  findUserById(id) {
    const row = this.db.prepare('SELECT * FROM auth_users WHERE id = ?').get(id)
    return row ? { ...publicUser(row), is_active: Number(row.is_active) !== 0 } : null
  }

  setUserActive(username, active) {
    const result = this.db
      .prepare('UPDATE auth_users SET is_active = ?, updated_at = ? WHERE username = ?')
      .run(active ? 1 : 0, nowIso(), normalizeUsername(username))
    return Number(result.changes) > 0
  }

  createSession({ userId, ttlMs, absoluteTtlMs, userAgent, clientIp }) {
    const id = randomUUID()
    const token = randomBytes(32).toString('hex')
    const now = Date.now()
    const createdAt = new Date(now).toISOString()
    this.db
      .prepare(`
        INSERT INTO auth_sessions(
          id, token_hash, user_id, created_at, last_seen_at, expires_at, absolute_expires_at, revoked_at, user_agent, client_ip
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `)
      .run(
        id,
        hashSessionToken(token),
        userId,
        createdAt,
        createdAt,
        new Date(now + ttlMs).toISOString(),
        new Date(now + absoluteTtlMs).toISOString(),
        userAgent ? String(userAgent).slice(0, 512) : null,
        clientIp ? String(clientIp).slice(0, 64) : null
      )
    return {
      id,
      token,
      expires_at: new Date(now + ttlMs).toISOString(),
      absolute_expires_at: new Date(now + absoluteTtlMs).toISOString()
    }
  }

  /**
   * Resolves a session token. Returns a discriminated result so callers can
   * distinguish "no such session" from "session revoked by the allowlist",
   * which matters for operator-facing diagnostics.
   */
  resolveSession(token, { ttlMs, absoluteTtlMs }) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 512) return { status: 'missing' }
    const row = this.db
      .prepare(`
        SELECT s.id AS session_id, s.created_at, s.last_seen_at, s.expires_at,
               s.absolute_expires_at, s.revoked_at,
               u.id AS user_id, u.username, u.display_name, u.email, u.role, u.is_active
          FROM auth_sessions s
          JOIN auth_users u ON u.id = s.user_id
         WHERE s.token_hash = ?
      `)
      .get(hashSessionToken(token))
    if (!row) return { status: 'missing' }
    if (row.revoked_at) return { status: 'revoked' }
    const now = Date.now()
    if (Number.isFinite(Date.parse(row.absolute_expires_at)) && Date.parse(row.absolute_expires_at) <= now) {
      return { status: 'expired' }
    }
    if (Number.isFinite(Date.parse(row.expires_at)) && Date.parse(row.expires_at) <= now) {
      return { status: 'expired' }
    }
    const absoluteExpiresAt = Date.parse(row.absolute_expires_at)
    const nextExpiry = Math.min(now + ttlMs, Number.isFinite(absoluteExpiresAt) ? absoluteExpiresAt : now + ttlMs)
    const lastSeenAt = nowIso()
    this.db
      .prepare('UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(lastSeenAt, new Date(nextExpiry).toISOString(), row.session_id)
    return {
      status: 'active',
      session: {
        id: row.session_id,
        created_at: row.created_at,
        last_seen_at: lastSeenAt,
        expires_at: new Date(nextExpiry).toISOString(),
        absolute_expires_at: row.absolute_expires_at
      },
      user: publicUser({ ...row, id: row.user_id })
    }
  }

  revokeSession(token) {
    if (typeof token !== 'string' || !token) return false
    const result = this.db
      .prepare('UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(nowIso(), hashSessionToken(token))
    return Number(result.changes) > 0
  }

  revokeAllForUser(username) {
    const user = this.findUserByUsername(username)
    if (!user) return 0
    const result = this.db
      .prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(nowIso(), user.id)
    return Number(result.changes)
  }

  revokeAll() {
    const result = this.db
      .prepare('UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL')
      .run(nowIso())
    return Number(result.changes)
  }

  cleanupExpired(reference = Date.now()) {
    const result = this.db
      .prepare('DELETE FROM auth_sessions WHERE expires_at <= ? OR absolute_expires_at <= ?')
      .run(new Date(reference).toISOString(), new Date(reference).toISOString())
    return Number(result.changes)
  }

  countActiveSessions(reference = Date.now()) {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS count FROM auth_sessions
         WHERE revoked_at IS NULL AND expires_at > ? AND absolute_expires_at > ?
      `)
      .get(new Date(reference).toISOString(), new Date(reference).toISOString())
    return Number(row?.count ?? 0)
  }

  close() {
    try {
      this.db.close()
    } catch {
      // Closing an already-closed handle is not an error worth surfacing.
    }
  }
}

export function sessionCookieOptions(config, { maxAgeMs } = {}) {
  const name = config?.session?.cookieName || SESSION_COOKIE_NAME_DEFAULT
  const options = {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(config?.session?.cookieSecure),
    path: '/'
  }
  // Express 5 takes maxAge in milliseconds; do not pre-convert to seconds here.
  if (Number.isFinite(maxAgeMs) && maxAgeMs > 0) options.maxAge = maxAgeMs
  return { name, options }
}

export function readCookie(header, name) {
  if (typeof header !== 'string' || !header || !name) return ''
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    const key = part.slice(0, separator).trim()
    if (key !== name) continue
    const value = part.slice(separator + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return ''
}
