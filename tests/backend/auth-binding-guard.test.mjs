import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAuthConfig, canBindHost, isLoopbackHost, resolveAllowlistPath } from '../../server/auth/config.js'
import { AccountAllowlist } from '../../server/auth/allowlist.js'

const fullEnv = {
  AUTH_ENABLED: 'true',
  LDAP_URL: 'ldap://ldap.example.test:389',
  LDAP_USER_DN_TEMPLATE: 'cn=%s,ou=People,dc=example,dc=test'
}

test('auth is disabled by default and keeps the legacy configuration', () => {
  const config = parseAuthConfig({})
  assert.equal(config.enabled, false)
  assert.equal(config.errors.length, 0)
  assert.equal(config.bind.allowNonLoopback, false)
  assert.deepEqual(config.bind.hosts, ['127.0.0.1', '::1'])
})

test('enabling auth without LDAP settings fails validation instead of starting half-configured', () => {
  const config = parseAuthConfig({ AUTH_ENABLED: 'true' })
  assert.equal(config.enabled, true)
  assert.equal(config.ready, false)
  assert.ok(config.errors.some((error) => error.includes('LDAP_URL')))
  assert.ok(config.errors.some((error) => error.includes('LDAP_USER_DN_TEMPLATE')))
})

test('the DN template must contain the substitution placeholder', () => {
  const config = parseAuthConfig({ ...fullEnv, LDAP_USER_DN_TEMPLATE: 'cn=people,ou=People,dc=example,dc=test' })
  assert.equal(config.ready, false)
  assert.ok(config.errors.some((error) => error.includes('%s')))
})

test('plaintext LDAP is recorded as a warning, and can be refused outright', () => {
  const verbose = parseAuthConfig(fullEnv)
  assert.equal(verbose.ldap.encrypted, false)
  assert.ok(verbose.warnings.includes('LDAP 明文连接已启用'))

  const strict = parseAuthConfig({ ...fullEnv, LDAP_ALLOW_PLAINTEXT: 'false' })
  assert.equal(strict.ready, false)
  assert.ok(strict.errors.some((error) => error.includes('LDAP_ALLOW_PLAINTEXT')))
})

test('a loopback host is always allowed, with or without authentication', () => {
  const disabled = parseAuthConfig({})
  assert.equal(canBindHost(disabled, '127.0.0.1').allowed, true)
  assert.equal(canBindHost(disabled, 'localhost').allowed, true)
  assert.equal(canBindHost(disabled, '::1').allowed, true)
  assert.equal(isLoopbackHost('LOCALHOST'), true)
})

test('no single switch is enough to bind a non-loopback address', () => {
  const cases = [
    [{}, '10.0.0.5'],
    [{ AUTH_ALLOW_NON_LOOPBACK: 'true' }, '10.0.0.5'],
    [{ ...fullEnv }, '10.0.0.5'],
    [{ ...fullEnv, AUTH_ALLOW_NON_LOOPBACK: 'true' }, '10.0.0.5'],
    [{ ...fullEnv, AUTH_BIND_HOSTS: '10.0.0.5' }, '10.0.0.5'],
    [{ AUTH_ALLOW_NON_LOOPBACK: 'true', AUTH_BIND_HOSTS: '10.0.0.5' }, '10.0.0.5']
  ]
  for (const [env, host] of cases) {
    const decision = canBindHost(parseAuthConfig(env), host)
    assert.equal(decision.allowed, false, `expected ${host} to be refused for ${JSON.stringify(env)}`)
    assert.ok(decision.reasons.length > 0)
  }
})

test('a non-loopback bind succeeds only when every condition is satisfied', () => {
  const config = parseAuthConfig({
    ...fullEnv,
    AUTH_ALLOW_NON_LOOPBACK: 'true',
    AUTH_BIND_HOSTS: '127.0.0.1,10.0.0.5'
  })
  assert.equal(config.ready, true)
  assert.equal(canBindHost(config, '10.0.0.5').allowed, true)
  assert.equal(canBindHost(config, '10.0.0.6').allowed, false)
})

test('session and rate-limit defaults follow the confirmed 15-user profile', () => {
  const config = parseAuthConfig(fullEnv)
  assert.equal(config.session.ttlMs, 12 * 60 * 60 * 1_000)
  assert.equal(config.session.absoluteTtlMs, 30 * 24 * 60 * 60 * 1_000)
  assert.equal(config.session.cookieSecure, false)
  assert.equal(config.session.trustProxy, false)
  assert.equal(config.rateLimit.usernameLimit, 5)
  assert.equal(config.rateLimit.usernameWindowMs, 5 * 60 * 1_000)
  assert.equal(config.rateLimit.ipLimit, 30)
  assert.equal(config.rateLimit.ipWindowMs, 60 * 1_000)
  assert.equal(config.allowlist.reloadMs, 30_000)
  assert.equal(config.revokeAllOnStart, false)
})

test('the emergency revoke-all switch is parsed but off by default', async () => {
  assert.equal(parseAuthConfig(fullEnv).revokeAllOnStart, false)
  assert.equal(parseAuthConfig({ ...fullEnv, AUTH_SESSION_REVOKE_ALL: 'true' }).revokeAllOnStart, true)

  const { createAuthService } = await import('../../server/auth/index.js')
  const { ServerAuthStore } = await import('../../server/auth/store.js')
  const warnings = []
  const store = new ServerAuthStore({ databasePath: ':memory:' })
  const auth = createAuthService({
    env: { ...fullEnv, AUTH_SESSION_REVOKE_ALL: 'true' },
    databasePath: ':memory:',
    authDatabasePath: ':memory:',
    store,
    createLdapClient: () => ({ bind: async () => {}, search: async () => ({ searchEntries: [] }), unbind: async () => {} }),
    logger: { warn: (message) => warnings.push(message) }
  })
  try {
    const user = store.upsertUser({ username: 'alice', ldapDn: 'cn=alice' })
    store.createSession({ userId: user.id, ttlMs: 60_000, absoluteTtlMs: 60_000 })
    assert.equal(store.countActiveSessions(), 1)
    // The switch acts at construction time, so a second start revokes the row
    // created after the first one.
    const second = createAuthService({
      env: { ...fullEnv, AUTH_SESSION_REVOKE_ALL: 'true' },
      databasePath: ':memory:',
      authDatabasePath: ':memory:',
      store,
      createLdapClient: () => ({ bind: async () => {}, search: async () => ({ searchEntries: [] }), unbind: async () => {} }),
      logger: { warn: (message) => warnings.push(message) }
    })
    void second
    assert.equal(store.countActiveSessions(), 0)
    assert.ok(warnings.some((message) => message.includes('AUTH_SESSION_REVOKE_ALL')))
  } finally {
    auth.close()
    if (store.db.open) store.close()
  }
})

test('the allowlist path defaults next to the business database', () => {
  const config = parseAuthConfig(fullEnv)
  assert.match(resolveAllowlistPath(config, 'C:\\data\\recruitment.db'), /auth-allowlist\.txt$/)
  assert.equal(resolveAllowlistPath(config, ':memory:'), '')
  const explicit = parseAuthConfig({ ...fullEnv, AUTH_ALLOWLIST_FILE: 'C:\\cfg\\allow.txt' })
  assert.equal(resolveAllowlistPath(explicit, ':memory:'), 'C:\\cfg\\allow.txt')
})

test('a missing allowlist file disables enforcement, matching the default deployment', () => {
  const allowlist = new AccountAllowlist({ path: '', logger: { warn() {} } })
  assert.equal(allowlist.enforced, false)
  assert.equal(allowlist.allows('anyone'), true)
})

test('an empty allowlist file denies everyone instead of opening access', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = mkdtempSync(join(tmpdir(), 'anonymous-allowlist-'))
  try {
    const path = join(directory, 'allowlist.txt')
    writeFileSync(path, '# nobody yet\n\n', 'utf8')
    const allowlist = new AccountAllowlist({ path, reloadMs: 1_000, logger: { warn() {} } })
    assert.equal(allowlist.enforced, true)
    assert.equal(allowlist.size, 0)
    assert.equal(allowlist.allows('alice'), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a deleted allowlist file keeps the last good list instead of opening access', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = mkdtempSync(join(tmpdir(), 'anonymous-allowlist-fail-'))
  const warnings = []
  try {
    const path = join(directory, 'allowlist.txt')
    writeFileSync(path, 'alice\n', 'utf8')
    const allowlist = new AccountAllowlist({ path, reloadMs: 1_000, logger: { warn: (message) => warnings.push(message) } })
    assert.equal(allowlist.allows('alice'), true)
    rmSync(path, { force: true })
    // Deleting the file while enforcement is on is an operator error. It must
    // fail closed: keep the previous list and surface the failure.
    allowlist.reloadIfStale(Date.now() + 10_000)
    assert.equal(allowlist.enforced, true)
    assert.equal(allowlist.allows('alice'), true)
    assert.equal(allowlist.allows('mallory'), false)
    assert.equal(allowlist.status().last_error, 'ENOENT')
    assert.equal(warnings.length, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('allowlist entries are trimmed, comment-stripped and case-insensitive', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = mkdtempSync(join(tmpdir(), 'anonymous-allowlist-parse-'))
  try {
    const path = join(directory, 'allowlist.txt')
    writeFileSync(path, '\uFEFFAlice\n  BOB  # trailing comment\n\n', 'utf8')
    const allowlist = new AccountAllowlist({ path, reloadMs: 1_000, logger: { warn() {} } })
    assert.equal(allowlist.size, 2)
    assert.equal(allowlist.allows('alice'), true)
    assert.equal(allowlist.allows('ALICE'), true)
    assert.equal(allowlist.allows('bob'), true)
    assert.equal(allowlist.allows('carol'), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a failing allowlist read keeps the last good list rather than opening access', async () => {
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = mkdtempSync(join(tmpdir(), 'anonymous-allowlist-broken-'))
  const warnings = []
  try {
    const path = join(directory, 'allowlist.txt')
    writeFileSync(path, 'alice\n', 'utf8')
    const allowlist = new AccountAllowlist({ path, reloadMs: 1_000, logger: { warn: (message) => warnings.push(message) } })
    assert.equal(allowlist.allows('alice'), true)
    rmSync(path, { force: true })
    // Replacing the file with a directory makes readFileSync fail with EISDIR,
    // which is the "controller is broken, not the policy" branch.
    mkdirSync(path)
    allowlist.reloadIfStale(Date.now() + 10_000)
    assert.equal(allowlist.enforced, true)
    assert.equal(allowlist.allows('alice'), true)
    assert.equal(allowlist.allows('mallory'), false)
    assert.equal(allowlist.status().last_error, 'EISDIR')
    assert.equal(warnings.length, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the allowlist reloads on its own, without any incoming request', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = mkdtempSync(join(tmpdir(), 'anonymous-allowlist-timer-'))
  try {
    const path = join(directory, 'allowlist.txt')
    writeFileSync(path, '# empty\n', 'utf8')
    // 1s is the smallest accepted interval; the production default is 30s.
    const allowlist = new AccountAllowlist({ path, reloadMs: 1_000, logger: { warn() {} } })
    try {
      assert.equal(allowlist.size, 0)
      writeFileSync(path, 'cboy\n', 'utf8')
      // No request is made here: the periodic timer alone must pick this up.
      await new Promise((resolve) => setTimeout(resolve, 1_600))
      assert.equal(allowlist.size, 1)
      assert.equal(allowlist.allows('cboy'), true)
    } finally {
      allowlist.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
