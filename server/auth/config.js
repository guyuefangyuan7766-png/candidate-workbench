import { resolve } from 'node:path'

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1_000
const DEFAULT_SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1_000
const DEFAULT_LDAP_TIMEOUT_MS = 8_000
const DEFAULT_LOGIN_RATE_LIMIT = 5
const DEFAULT_LOGIN_RATE_WINDOW_MS = 5 * 60 * 1_000
const DEFAULT_LOGIN_IP_RATE_LIMIT = 30
const DEFAULT_LOGIN_IP_RATE_WINDOW_MS = 60 * 1_000
const DEFAULT_ALLOWLIST_RELOAD_MS = 30_000
const DEFAULT_COOKIE_NAME = 'workbench_session'

export const AUTH_CONFIG_ERROR = 'auth_config_invalid'

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function integer(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(text(value), 10)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback
  return parsed
}

function boolean(value, fallback = false) {
  const normalized = text(value).toLowerCase()
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0') return false
  if (normalized === '') return fallback
  return fallback
}

function list(value) {
  return text(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeUsername(value) {
  return text(value).replace(/^[^\\/]*\\/, '').toLowerCase()
}

export function parseAuthConfig(env = process.env) {
  const enabled = boolean(env.AUTH_ENABLED, false)
  const errors = []
  const warnings = []

  const ldapUrl = text(env.LDAP_URL)
  const userDnTemplate = text(env.LDAP_USER_DN_TEMPLATE)
  const bindDn = text(env.LDAP_BIND_DN)
  const bindPassword = typeof env.LDAP_BIND_PASSWORD === 'string' ? env.LDAP_BIND_PASSWORD : ''
  const attributeLookup = (text(env.LDAP_ATTRIBUTE_LOOKUP) || 'off').toLowerCase()

  if (enabled) {
    if (!ldapUrl) errors.push('AUTH_ENABLED=true 时必须设置 LDAP_URL')
    if (!userDnTemplate) errors.push('AUTH_ENABLED=true 时必须设置 LDAP_USER_DN_TEMPLATE')
    if (!userDnTemplate.includes('%s')) errors.push('LDAP_USER_DN_TEMPLATE 必须包含 %s 占位符')
    if (!['off', 'anonymous', 'service'].includes(attributeLookup)) {
      errors.push('LDAP_ATTRIBUTE_LOOKUP 只支持 off / anonymous / service')
    }
    if (attributeLookup === 'service' && (!bindDn || !bindPassword)) {
      errors.push('LDAP_ATTRIBUTE_LOOKUP=service 需要同时配置 LDAP_BIND_DN 与 LDAP_BIND_PASSWORD')
    }
    if (!bindDn !== !bindPassword) {
      errors.push('LDAP_BIND_DN 与 LDAP_BIND_PASSWORD 必须成对配置')
    }
  }

  let ldapProtocol = ''
  let ldapHost = ''
  if (ldapUrl) {
    try {
      const parsed = new URL(ldapUrl)
      ldapProtocol = parsed.protocol.replace(':', '').toLowerCase()
      ldapHost = parsed.hostname
      if (!['ldap', 'ldaps'].includes(ldapProtocol)) {
        errors.push('LDAP_URL 只支持 ldap:// 或 ldaps://')
      }
    } catch {
      errors.push('LDAP_URL 不是合法的 URL')
    }
  }

  const startTls = boolean(env.LDAP_STARTTLS, false)
  const allowPlaintext = boolean(env.LDAP_ALLOW_PLAINTEXT, true)
  const encrypted = ldapProtocol === 'ldaps' || startTls
  if (enabled && ldapProtocol === 'ldap' && !startTls) {
    if (!allowPlaintext) errors.push('LDAP_ALLOW_PLAINTEXT=false 但 LDAP_URL 是明文 ldap:// 且未启用 STARTTLS')
    else warnings.push('LDAP 明文连接已启用')
  }

  const bindHosts = list(env.AUTH_BIND_HOSTS)
  const allowNonLoopback = boolean(env.AUTH_ALLOW_NON_LOOPBACK, false)
  const cookieSecure = boolean(env.AUTH_COOKIE_SECURE, false)

  return {
    enabled,
    ready: enabled && errors.length === 0,
    errors,
    warnings,
    bind: {
      allowNonLoopback,
      hosts: bindHosts.length ? bindHosts : ['127.0.0.1', '::1']
    },
    session: {
      cookieName: text(env.AUTH_COOKIE_NAME) || DEFAULT_COOKIE_NAME,
      cookieSecure,
      trustProxy: boolean(env.AUTH_TRUST_PROXY, false),
      ttlMs: integer(env.AUTH_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS, 60_000, 365 * 24 * 60 * 60 * 1_000),
      absoluteTtlMs: integer(
        env.AUTH_SESSION_ABSOLUTE_TTL_MS,
        DEFAULT_SESSION_ABSOLUTE_TTL_MS,
        60_000,
        365 * 24 * 60 * 60 * 1_000
      )
    },
    allowlist: {
      file: text(env.AUTH_ALLOWLIST_FILE),
      bootstrapUsers: list(env.AUTH_ALLOWED_USERS).map(normalizeUsername),
      reloadMs: integer(env.AUTH_ALLOWLIST_RELOAD_MS, DEFAULT_ALLOWLIST_RELOAD_MS, 1_000, 10 * 60 * 1_000)
    },
    revokeAllOnStart: boolean(env.AUTH_SESSION_REVOKE_ALL, false),
    rateLimit: {
      usernameLimit: integer(env.AUTH_LOGIN_RATE_LIMIT, DEFAULT_LOGIN_RATE_LIMIT, 1, 1_000),
      usernameWindowMs: integer(env.AUTH_LOGIN_RATE_WINDOW_MS, DEFAULT_LOGIN_RATE_WINDOW_MS, 1_000, 24 * 60 * 60 * 1_000),
      ipLimit: integer(env.AUTH_LOGIN_IP_RATE_LIMIT, DEFAULT_LOGIN_IP_RATE_LIMIT, 1, 10_000),
      ipWindowMs: integer(env.AUTH_LOGIN_IP_RATE_WINDOW_MS, DEFAULT_LOGIN_IP_RATE_WINDOW_MS, 1_000, 24 * 60 * 60 * 1_000)
    },
    ldap: {
      url: ldapUrl,
      host: ldapHost,
      protocol: ldapProtocol,
      encrypted,
      startTls,
      allowPlaintext,
      userDnTemplate,
      uidAttribute: text(env.LDAP_UID_ATTRIBUTE) || 'uid',
      nameAttributes: list(env.LDAP_NAME_ATTRIBUTE).length ? list(env.LDAP_NAME_ATTRIBUTE) : ['cn'],
      emailAttribute: text(env.LDAP_EMAIL_ATTRIBUTE) || 'mail',
      attributeLookup,
      searchBase: text(env.LDAP_USER_SEARCH_BASE) || 'ou=People,dc=wooduan,dc=com',
      userFilter: text(env.LDAP_USER_FILTER) || '(uid={username})',
      bindDn,
      bindPassword,
      timeoutMs: integer(env.LDAP_TIMEOUT_MS, DEFAULT_LDAP_TIMEOUT_MS, 500, 60_000)
    }
  }
}

export function resolveAllowlistPath(config, databasePath) {
  if (config.allowlist.file) return resolve(config.allowlist.file)
  if (databasePath && databasePath !== ':memory:') {
    return resolve(databasePath, '..', 'auth-allowlist.txt')
  }
  return ''
}

export function describeAuthStartup(config, databasePath) {
  if (!config.enabled) return '认证未启用（AUTH_ENABLED=false），服务保持个人回环模式'
  const parts = [
    `认证已启用（直接绑定模式）`,
    `LDAP=${config.ldap.protocol}://${config.ldap.host}`,
    config.ldap.encrypted ? '加密连接' : '明文连接',
    `属性读取=${config.ldap.attributeLookup}`,
    `会话空闲 ${Math.round(config.session.ttlMs / 3_600_000)}h / 绝对 ${Math.round(config.session.absoluteTtlMs / 86_400_000)}d`,
    `白名单=${resolveAllowlistPath(config, databasePath) || '环境变量'}`,
    `非回环监听=${config.bind.allowNonLoopback ? '允许' : '禁止'}`
  ]
  return parts.join('；')
}

export function assertAuthConfig(config) {
  if (config.enabled && config.errors.length) {
    const error = new Error(`认证配置无效：${config.errors.join('；')}`)
    error.code = AUTH_CONFIG_ERROR
    error.details = { errors: config.errors }
    throw error
  }
  return config
}

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host ?? '').toLowerCase())
}

/**
 * Decides whether the process may bind the requested host.
 *
 * Binding to anything other than loopback requires every one of: the auth
 * switch, explicit non-loopback opt-in, a complete LDAP configuration, and a
 * match against the configured host allowlist. Any single missing condition
 * keeps the process on the loopback-only default.
 */
export function canBindHost(config, host) {
  const normalized = String(host ?? '').toLowerCase()
  if (isLoopbackHost(normalized)) return { allowed: true }
  const reasons = []
  if (!config.enabled) reasons.push('AUTH_ENABLED 未启用')
  if (!config.bind.allowNonLoopback) reasons.push('AUTH_ALLOW_NON_LOOPBACK 未启用')
  if (config.enabled && !config.ready) reasons.push('LDAP 配置不完整')
  if (!config.bind.hosts.map((item) => item.toLowerCase()).includes(normalized)) {
    reasons.push(`地址不在 AUTH_BIND_HOSTS 白名单内（当前：${config.bind.hosts.join(',')}）`)
  }
  if (reasons.length) return { allowed: false, reasons }
  return { allowed: true }
}
