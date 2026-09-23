import { AuthError, AUTH_ERROR_CODES } from './ldap.js'
import { readCookie, sessionCookieOptions } from './store.js'

const PUBLIC_API_PATHS = new Set(['/api/health', '/api/auth/login', '/api/auth/status'])

function nowMs() {
  return Date.now()
}

export function createRateLimiter(options = {}) {
  const usernameLimit = options.usernameLimit ?? 5
  const usernameWindowMs = options.usernameWindowMs ?? 5 * 60 * 1_000
  const ipLimit = options.ipLimit ?? 30
  const ipWindowMs = options.ipWindowMs ?? 60 * 1_000
  const usernameAttempts = new Map()
  const ipAttempts = new Map()

  function prune(bucket, reference, windowMs) {
    const cutoff = reference - windowMs
    while (bucket.length && bucket[0] <= cutoff) bucket.shift()
  }

  function inspect(bucket, reference, windowMs, limit) {
    prune(bucket, reference, windowMs)
    if (bucket.length < limit) return null
    const retryAfterMs = Math.max(1_000, bucket[0] + windowMs - reference)
    return { retryAfterMs }
  }

  return {
    check(username, ip) {
      const reference = nowMs()
      const byUser = usernameAttempts.get(username) ?? []
      const userBlocked = inspect(byUser, reference, usernameWindowMs, usernameLimit)
      usernameAttempts.set(username, byUser)
      if (userBlocked) return { scope: 'username', ...userBlocked }
      if (ip) {
        const byIp = ipAttempts.get(ip) ?? []
        const ipBlocked = inspect(byIp, reference, ipWindowMs, ipLimit)
        ipAttempts.set(ip, byIp)
        if (ipBlocked) return { scope: 'ip', ...ipBlocked }
      }
      return null
    },
    recordFailure(username, ip) {
      const reference = nowMs()
      const byUser = usernameAttempts.get(username) ?? []
      byUser.push(reference)
      prune(byUser, reference, usernameWindowMs)
      usernameAttempts.set(username, byUser)
      if (ip) {
        const byIp = ipAttempts.get(ip) ?? []
        byIp.push(reference)
        prune(byIp, reference, ipWindowMs)
        ipAttempts.set(ip, byIp)
      }
    },
    recordSuccess(username) {
      usernameAttempts.delete(username)
    },
    reset() {
      usernameAttempts.clear()
      ipAttempts.clear()
    }
  }
}

function extractToken(req, cookieName) {
  const header = req.get?.('Authorization') ?? req.headers?.authorization
  if (typeof header === 'string' && /^bearer\s+/i.test(header)) {
    return header.replace(/^bearer\s+/i, '').trim()
  }
  const cookies = req.headers?.cookie
  return readCookie(cookies, cookieName)
}

function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers?.['x-forwarded-for']
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
    if (typeof value === 'string' && value.trim()) {
      const candidate = value.split(',')[0].trim()
      if (candidate) return candidate.slice(0, 64)
    }
  }
  return String(req.socket?.remoteAddress ?? '').slice(0, 64)
}

function isPublicPath(pathname) {
  return PUBLIC_API_PATHS.has(pathname)
}

function sessionError(reason) {
  if (reason === 'expired') return new AuthError(401, AUTH_ERROR_CODES.SESSION_EXPIRED, '登录状态已过期，请重新登录')
  return new AuthError(401, AUTH_ERROR_CODES.REQUIRED, '请先登录')
}

/**
 * Builds the authentication surface: four auth endpoints plus the guard that
 * protects every other /api route.
 *
 * The guard is mounted by path rather than per route so that a newly added
 * business endpoint is protected by default; forgetting to opt in is not
 * possible, only forgetting to add it to PUBLIC_API_PATHS.
 */
export function createAuthMiddleware(options = {}) {
  const store = options.store
  const ldap = options.ldap
  const allowlist = options.allowlist
  const config = options.config
  if (!store || !ldap || !allowlist || !config) {
    throw new Error('createAuthMiddleware requires store, ldap, allowlist and config')
  }
  const rateLimiter = options.rateLimiter ?? createRateLimiter(config.rateLimit)
  const { name: cookieName, options: cookieOptions } = sessionCookieOptions(config)
  const logger = options.logger ?? console
  // Auth failures are otherwise invisible: the browser just returns to the
  // login page and the server keeps no record of why. This flag turns on a
  // single diagnostic line per rejected request, including which Cookie header
  // names actually arrived, so cookie loss can be told apart from expiry,
  // revocation and allowlist removal.
  const diagnostics = options.diagnostics ?? process.env.AUTH_DEBUG === '1'

  function describeRequestCookies(req) {
    const header = req?.headers?.cookie
    if (typeof header !== 'string' || !header) return '(no Cookie header)'
    const names = header
      .split(';')
      .map((part) => part.split('=')[0]?.trim())
      .filter(Boolean)
    return names.length ? names.join(',') : '(empty Cookie header)'
  }

  function recordAuthRejection(req, status, token) {
    if (!diagnostics) return
    logger.warn?.(
      `[auth] 拒绝请求 reason=${status}` +
      ` path=${req?.path ?? req?.url ?? '-'}` +
      ` method=${req?.method ?? '-'}` +
      ` cookie=${cookieName}` +
      ` token=${token ? token.length + ' chars' : 'absent'}` +
      ` headerCookies=[${describeRequestCookies(req)}]` +
      ` ua=${String(req?.headers?.['user-agent'] ?? '-').slice(0, 60)}`
    )
  }

  function sessionTtls() {
    return { ttlMs: config.session.ttlMs, absoluteTtlMs: config.session.absoluteTtlMs }
  }

  function clearCookie(res) {
    res.clearCookie(cookieName, { ...cookieOptions, maxAge: undefined })
  }

  function resolveRequestSession(req) {
    allowlist.reloadIfStale()
    const token = extractToken(req, cookieName)
    if (!token) {
      recordAuthRejection(req, 'missing-cookie', null)
      return { error: sessionError('missing') }
    }
    const resolved = store.resolveSession(token, sessionTtls())
    if (resolved.status !== 'active') {
      recordAuthRejection(req, 'session-' + resolved.status, token)
      return { error: sessionError(resolved.status) }
    }
    const user = resolved.user
    const record = store.findUserById(user.id)
    if (!record || !record.is_active) {
      store.revokeSession(token)
      recordAuthRejection(req, 'account-disabled', token)
      return { error: new AuthError(403, AUTH_ERROR_CODES.ACCOUNT_DISABLED, '账号已被停用') }
    }
    if (!allowlist.allows(user.username)) {
      // Removing an account from the allowlist must take effect immediately,
      // not when the session would have expired on its own.
      store.revokeSession(token)
      recordAuthRejection(req, 'allowlist-denied:' + user.username, token)
      return { error: new AuthError(403, AUTH_ERROR_CODES.NOT_AUTHORIZED, '账号未获授权使用该系统') }
    }
    return { token, user, session: resolved.session }
  }

  function requireSession(req, res, next) {
    const resolved = resolveRequestSession(req)
    if (resolved.error) return next(resolved.error)
    req.auth = { user: resolved.user, session: resolved.session, token: resolved.token }
    res.setHeader('Cache-Control', 'private, no-store')
    return next()
  }

  function guard(req, res, next) {
    const pathname = req.path ?? req.url ?? ''
    if (isPublicPath(pathname)) return next()
    return requireSession(req, res, next)
  }

  async function loginHandler(req, res, next) {
    try {
      const rawUsername = req.body?.username
      const password = req.body?.password
      const ip = clientAddress(req, config.session.trustProxy)
      const usernameKey = String(rawUsername ?? '').trim().replace(/^[^\\/]*\\/, '').toLowerCase()
      const blocked = usernameKey ? rateLimiter.check(usernameKey, ip) : null
      if (blocked) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(blocked.retryAfterMs / 1_000))))
        throw new AuthError(429, AUTH_ERROR_CODES.RATE_LIMITED, '登录尝试过于频繁，请稍后再试')
      }
      let result
      try {
        result = await ldap.authenticate({
          username: rawUsername,
          password,
          userAgent: req.get?.('User-Agent') ?? undefined,
          clientIp: ip,
          session: sessionTtls()
        })
      } catch (error) {
        if (error?.code === AUTH_ERROR_CODES.INVALID_CREDENTIALS && usernameKey) {
          rateLimiter.recordFailure(usernameKey, ip)
        }
        throw error
      }
      allowlist.reloadIfStale()
      if (!allowlist.allows(result.user.username)) {
        throw new AuthError(403, AUTH_ERROR_CODES.NOT_AUTHORIZED, '账号未获授权使用该系统')
      }
      const record = store.findUserById(result.user.id)
      if (!record || !record.is_active) {
        throw new AuthError(403, AUTH_ERROR_CODES.ACCOUNT_DISABLED, '账号已被停用')
      }
      rateLimiter.recordSuccess(usernameKey)
      // Express 5 expects maxAge in MILLISECONDS and converts it to the
      // Max-Age attribute by dividing by 1000. Passing seconds here silently
      // produced "Max-Age=43" for a 12 hour session.
      const cookieMaxAgeMs = config.session.ttlMs
      res.cookie(cookieName, result.session.token, {
        ...cookieOptions,
        maxAge: cookieMaxAgeMs
      })
      if (diagnostics) {
        // The browser only sees what actually leaves the process; log the exact
        // values used so a proxy rewrite can be told apart from a bad config.
        logger.warn?.(
          `[auth] 下发会话 cookie=${cookieName}` +
          ` maxAgeMs=${cookieMaxAgeMs}` +
          ` (即 ` + Math.floor(cookieMaxAgeMs / 1_000) + ` 秒)` +
          ` ttlMs=${config.session.ttlMs}` +
          ` secure=${cookieOptions.secure}` +
          ` sessionExpires=${result.session.expires_at}` +
          ` user=${result.user.username}`
        )
      }
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({
        user: record ? { ...result.user, display_name: result.user.display_name || result.user.username } : result.user,
        expires_at: result.session.expires_at
      })
    } catch (error) {
      next(error)
    }
  }

  function logoutHandler(req, res) {
    const token = extractToken(req, cookieName)
    if (token) store.revokeSession(token)
    clearCookie(res)
    res.setHeader('Cache-Control', 'private, no-store')
    res.status(204).end()
  }

  function sessionHandler(req, res, next) {
    const resolved = resolveRequestSession(req)
    if (resolved.error) return next(resolved.error)
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({ user: resolved.user, expires_at: resolved.session?.expires_at ?? null })
  }

  function meHandler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({ user: req.auth.user })
  }

  return {
    cookieName,
    cookieOptions,
    guard,
    requireSession,
    loginHandler,
    logoutHandler,
    sessionHandler,
    meHandler,
    rateLimiter,
    resolveRequestSession,
    allowlist,
    store,
    status() {
      return {
        enabled: true,
        mode: 'ldap-direct-bind',
        attribute_lookup: config.ldap.attributeLookup,
        encrypted_transport: config.ldap.encrypted,
        cookie_secure: config.session.cookieSecure,
        trust_proxy: config.session.trustProxy,
        session_ttl_ms: config.session.ttlMs,
        session_absolute_ttl_ms: config.session.absoluteTtlMs,
        allowlist: allowlist.status()
      }
    }
  }
}
