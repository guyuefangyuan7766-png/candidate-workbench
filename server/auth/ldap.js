import { Client } from 'ldapts'

export const AUTH_ERROR_CODES = {
  INVALID_CREDENTIALS: 'invalid_credentials',
  BACKEND_UNAVAILABLE: 'auth_backend_unavailable',
  NOT_AUTHORIZED: 'account_not_authorized',
  ACCOUNT_DISABLED: 'account_disabled',
  RATE_LIMITED: 'auth_rate_limited',
  REQUIRED: 'authentication_required',
  SESSION_EXPIRED: 'session_expired'
}

export class AuthError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'AuthError'
    this.status = status
    this.code = code
    if (details !== undefined) this.details = details
  }
}

const LDAP_INVALID_CREDENTIALS = 49
const LDAP_TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ECONNABORTED', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND'])

/**
 * Escapes a value for use as an RDN attribute value (RFC 4514 section 2.4).
 * Login identifiers reach the DN template, so escaping is mandatory: a bare
 * comma or plus sign in a username would otherwise change the DN structure.
 */
export function escapeDnValue(value) {
  const text = String(value ?? '')
  let escaped = ''
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\') escaped += '\\5c'
    else if (character === '"') escaped += '\\22'
    else if (character === '#') escaped += '\\23'
    else if (character === ',') escaped += '\\2c'
    else if (character === '+') escaped += '\\2b'
    else if (character === ';') escaped += '\\3b'
    else if (character === '<') escaped += '\\3c'
    else if (character === '>') escaped += '\\3e'
    else if (character === '=') escaped += '\\3d'
    else if (character === '\u0000') escaped += '\\00'
    else if (index === 0 && character === ' ') escaped += '\\20'
    else if (index === text.length - 1 && character === ' ') escaped += '\\20'
    else escaped += character
  }
  return escaped
}

export function normalizeLoginIdentifier(value) {
  let text = String(value ?? '').trim()
  if (!text) return ''
  text = text.replace(/^[^\\/]*\\/, '')
  if (text.length > 200) text = text.slice(0, 200)
  return text
}

export function buildUserDn(template, identifier) {
  if (typeof template !== 'string' || !template.includes('%s')) {
    throw new AuthError(500, 'auth_config_invalid', 'LDAP 用户 DN 模板无效')
  }
  return template.replaceAll('%s', escapeDnValue(identifier))
}

function firstAttributeValue(entry, names) {
  if (!entry || typeof entry !== 'object') return ''
  for (const name of names) {
    const direct = entry[name] ?? entry[name.toLowerCase()]
    if (Array.isArray(direct) && direct.length) {
      const value = direct.find((item) => typeof item === 'string' && item.trim())
      if (value) return value.trim()
      continue
    }
    if (typeof direct === 'string' && direct.trim()) return direct.trim()
  }
  const lower = new Map(Object.entries(entry).map(([key, value]) => [key.toLowerCase(), value]))
  for (const name of names) {
    const value = lower.get(String(name).toLowerCase())
    if (Array.isArray(value) && value.length) {
      const match = value.find((item) => typeof item === 'string' && item.trim())
      if (match) return match.trim()
      continue
    }
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function classifyLdapFailure(error) {
  if (error instanceof AuthError) return error
  const message = String(error?.message ?? '')
  if (error?.code === LDAP_INVALID_CREDENTIALS || /invalid credentials|invalidcredentials/i.test(message)) {
    return new AuthError(401, AUTH_ERROR_CODES.INVALID_CREDENTIALS, '账号或密码不正确')
  }
  if (
    LDAP_TIMEOUT_CODES.has(error?.code) ||
    /timeout|timed out|socket hang up|ECONNRESET|not open/i.test(message)
  ) {
    return new AuthError(503, AUTH_ERROR_CODES.BACKEND_UNAVAILABLE, '账号服务暂时不可用，请稍后重试')
  }
  if (error?.code === 32 || /no such object/i.test(message)) {
    return new AuthError(401, AUTH_ERROR_CODES.INVALID_CREDENTIALS, '账号或密码不正确')
  }
  return new AuthError(503, AUTH_ERROR_CODES.BACKEND_UNAVAILABLE, '账号服务暂时不可用，请稍后重试')
}

function defaultClientFactory(config) {
  return new Client({
    url: config.url,
    timeout: config.timeoutMs,
    connectTimeout: config.timeoutMs,
    strictDN: false
  })
}

/**
 * Creates the LDAP authenticator.
 *
 * The confirmed environment uses direct binding: login identifier -> DN
 * template -> single bind with the user's own password. Attribute reading is a
 * best-effort cosmetic step that never changes the authentication result.
 */
export function createLdapAuthenticator(options = {}) {
  const config = options.config
  if (!config) throw new Error('createLdapAuthenticator requires a config')
  const createClient = options.createClient ?? defaultClientFactory
  const store = options.store
  if (!store) throw new Error('createLdapAuthenticator requires a store')
  const logger = options.logger ?? console

  async function client() {
    return createClient(config)
  }

  async function readAttributes(connection, identifier) {
    if (config.attributeLookup !== 'anonymous') return { displayName: '', email: '' }
    const filterTemplate = config.userFilter || '(uid={username})'
    const filter = filterTemplate.replaceAll('{username}', identifier.replace(/([()\\*])/g, '\\$1'))
    const attributes = [...config.nameAttributes, config.emailAttribute].filter(Boolean)
    const result = await connection.search(config.searchBase, { scope: 'sub', filter, attributes, sizeLimit: 2 })
    const entries = Array.isArray(result?.searchEntries) ? result.searchEntries : []
    if (entries.length !== 1) return { displayName: '', email: '' }
    return {
      displayName: firstAttributeValue(entries[0], config.nameAttributes),
      email: firstAttributeValue(entries[0], [config.emailAttribute])
    }
  }

  async function authenticate({ username, password, userAgent, clientIp, session }) {
    const identifier = normalizeLoginIdentifier(username)
    if (!identifier) throw new AuthError(422, 'validation_error', '请输入账号', [{ field: 'username' }])
    if (typeof password !== 'string' || !password) {
      throw new AuthError(422, 'validation_error', '请输入密码', [{ field: 'password' }])
    }
    if (password.length > 512) {
      throw new AuthError(422, 'validation_error', '密码长度超出允许范围', [{ field: 'password' }])
    }
    const dn = buildUserDn(config.userDnTemplate, identifier)
    const connection = await client()
    let attributes = { displayName: '', email: '' }
    try {
      await connection.bind(dn, password)
      try {
        attributes = await readAttributes(connection, identifier)
      } catch (error) {
        // Attribute lookup is cosmetic. Directory policy, timeouts and filter
        // mismatches must never turn a successful bind into a failed login.
        logger.warn?.(`LDAP 属性读取跳过：${error?.code ?? error?.message ?? 'unknown'}`)
        attributes = { displayName: '', email: '' }
      }
    } catch (error) {
      throw classifyLdapFailure(error)
    } finally {
      try {
        await connection.unbind()
      } catch {
        // The bind result already decided the outcome; unbind failures are noise.
      }
    }
    const user = store.upsertUser({
      username: identifier,
      ldapDn: dn,
      displayName: attributes.displayName || identifier,
      email: attributes.email || null
    })
    const created = store.createSession({
      userId: user.id,
      ttlMs: session.ttlMs,
      absoluteTtlMs: session.absoluteTtlMs,
      userAgent,
      clientIp
    })
    return { user, session: created, ldapDn: dn }
  }

  return { authenticate, config }
}

