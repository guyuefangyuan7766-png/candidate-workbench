import { resolve, dirname } from 'node:path'
import { parseAuthConfig, assertAuthConfig, resolveAllowlistPath, describeAuthStartup } from './config.js'
import { ServerAuthStore } from './store.js'
import { AccountAllowlist } from './allowlist.js'
import { createLdapAuthenticator } from './ldap.js'
import { createAuthMiddleware } from './middleware.js'

function defaultAuthDatabasePath(databasePath) {
  if (!databasePath || databasePath === ':memory:') return ':memory:'
  return resolve(dirname(databasePath), 'auth.db')
}

export function createAuthService(options = {}) {
  const env = options.env ?? process.env
  const config = assertAuthConfig(options.config ?? parseAuthConfig(env))
  const logger = options.logger ?? console
  const databasePath = options.databasePath ?? ':memory:'
  const authDatabasePath = options.authDatabasePath
    ?? (env.AUTH_DB_PATH ? resolve(env.AUTH_DB_PATH) : defaultAuthDatabasePath(databasePath))
  const ownsStore = !options.store
  const store = options.store ?? new ServerAuthStore({ databasePath: authDatabasePath })
  const allowlist = options.allowlist ?? new AccountAllowlist({
    path: resolveAllowlistPath(config, databasePath),
    bootstrapUsers: config.allowlist.bootstrapUsers,
    reloadMs: config.allowlist.reloadMs,
    logger
  })
  const ldap = options.ldap ?? createLdapAuthenticator({
    config: config.ldap,
    store,
    createClient: options.createLdapClient,
    logger
  })
  const middleware = createAuthMiddleware({
    config, store, ldap, allowlist,
    rateLimiter: options.rateLimiter,
    logger,
    diagnostics: options.diagnostics
  })
  if (config.revokeAllOnStart) {
    const revoked = store.revokeAll()
    logger.warn?.(`AUTH_SESSION_REVOKE_ALL 已启用：撤销了 ${revoked} 个活动会话，请在该开关应关闭后立即移除配置`)
  }
  const cleanupTimer = setInterval(() => {
    try {
      store.cleanupExpired()
    } catch (error) {
      logger.warn?.(`清理过期会话失败：${error?.message ?? 'unknown'}`)
    }
  }, 60 * 60 * 1_000)
  cleanupTimer.unref?.()

  return {
    config,
    store,
    allowlist,
    ldap,
    middleware,
    databasePath: authDatabasePath,
    summary: describeAuthStartup(config, databasePath),
    close() {
      clearInterval(cleanupTimer)
      allowlist.close?.()
      // A caller-supplied store belongs to the caller (tests and the Express
      // app both close it explicitly), so only close what we created.
      if (ownsStore) store.close()
    }
  }
}

export { parseAuthConfig, canBindHost, isLoopbackHost, resolveAllowlistPath, describeAuthStartup } from './config.js'
export { ServerAuthStore, hashSessionToken, normalizeUsername, readCookie, sessionCookieOptions } from './store.js'
export { AccountAllowlist } from './allowlist.js'
export { createLdapAuthenticator, buildUserDn, escapeDnValue, normalizeLoginIdentifier, AuthError, AUTH_ERROR_CODES } from './ldap.js'
export { createAuthMiddleware, createRateLimiter } from './middleware.js'
