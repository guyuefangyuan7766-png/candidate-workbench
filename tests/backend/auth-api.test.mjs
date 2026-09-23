import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../../server/app.js'
import { createAuthService } from '../../server/auth/index.js'
import { insertCandidate } from '../../server/candidates.js'
import { createFakeLdapClient } from './ldap-fake-client.mjs'

const cleanups = []

test.afterEach(async () => {
  while (cleanups.length) await cleanups.pop()()
})

async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return { url: `http://127.0.0.1:${server.address().port}` }
}

function authEnv(overrides = {}) {
  return {
    AUTH_ENABLED: 'true',
    LDAP_URL: 'ldap://ldap.example.test:389',
    LDAP_USER_DN_TEMPLATE: 'cn=%s,ou=People,dc=example,dc=test',
    LDAP_ATTRIBUTE_LOOKUP: 'off',
    AUTH_COOKIE_SECURE: 'false',
    ...overrides
  }
}

async function startAuthedApp(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'anonymous-auth-api-'))
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }))
  const allowlistPath = join(directory, 'auth-allowlist.txt')
  if (options.allowlist !== null) {
    writeFileSync(allowlistPath, options.allowlist ?? 'alice\n', 'utf8')
  }
  const env = authEnv(options.env)
  const fake = createFakeLdapClient(options.fakeClient ?? {})
  const auth = createAuthService({
    env,
    databasePath: ':memory:',
    authDatabasePath: join(directory, 'auth.db'),
    allowlist: undefined,
    createLdapClient: () => fake.create(),
    logger: { warn() {}, log() {} }
  })
  // Point the allowlist at the temporary file (createAuthService defaults to a
  // path next to the business database, which is :memory: in tests).
  auth.allowlist.path = allowlistPath
  auth.allowlist.lastLoadedAt = 0
  auth.allowlist.reloadIfStale()
  const app = createApp({ databasePath: ':memory:', auth })
  const db = app.locals.db
  const candidate = insertCandidate(db, { name: '匿名候选人', email: 'anonymous@example.test' })
  const running = await listen(app)
  cleanups.push(async () => {
    await app.closeDatabase()
    auth.close()
  })
  return { app, auth, fake, allowlistPath, candidate, env, ...running }
}

async function request(url, options = {}) {
  const headers = new Headers(options.headers)
  if (options.body && typeof options.body !== 'string' && !(options.body instanceof FormData)) {
    headers.set('content-type', 'application/json')
  }
  const response = await fetch(url, {
    ...options,
    headers,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  })
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}

function cookieFrom(response) {
  const header = response.headers.get('set-cookie')
  assert.ok(header, 'expected a session cookie')
  return header.split(';')[0]
}

test('every business endpoint rejects anonymous access when auth is enabled', async () => {
  const { url, candidate } = await startAuthedApp()
  const paths = [
    '/api/candidates',
    '/api/dashboard',
    '/api/positions',
    '/api/talent-pools',
    `/api/candidates/${candidate.id}`,
    '/api/export',
    '/api/agent/status',
    '/api/agent/sessions',
    '/api/resume-search/status',
    '/api/attachments/00000000-0000-4000-8000-000000000000/text'
  ]
  for (const path of paths) {
    const { response, body } = await request(`${url}${path}`)
    assert.equal(response.status, 401, `${path} should require authentication`)
    assert.equal(body.error.code, 'authentication_required')
  }
})

test('health and auth status stay public and leak no credentials', async () => {
  const { url } = await startAuthedApp()
  const health = await request(`${url}/api/health`)
  assert.equal(health.response.status, 200)
  assert.equal(health.body.status, 'ok')

  const status = await request(`${url}/api/auth/status`)
  assert.equal(status.response.status, 200)
  assert.equal(status.body.enabled, true)
  assert.equal(status.body.mode, 'ldap-direct-bind')
  assert.equal(status.body.allowlist.enforced, true)
  assert.equal(status.body.allowlist.size, 1)
  const serialized = JSON.stringify(status.body)
  assert.equal(serialized.includes('alice'), false, 'status must not expose allowlist contents')
  assert.equal(serialized.includes('secret'), false)
})

test('login accepts a valid credential and grants access to business endpoints', async () => {
  const { url, fake } = await startAuthedApp()
  const login = await request(`${url}/api/auth/login`, {
    method: 'POST',
    body: { username: 'alice', password: 'alice-secret' }
  })
  assert.equal(login.response.status, 200)
  assert.equal(login.body.user.username, 'alice')
  const cookie = cookieFrom(login.response)
  assert.match(login.response.headers.get('set-cookie'), /HttpOnly/i)
  assert.match(login.response.headers.get('set-cookie'), /SameSite=Lax/i)

  const candidates = await request(`${url}/api/candidates`, { headers: { cookie } })
  assert.equal(candidates.response.status, 200)
  assert.equal(candidates.body.items.length, 1)
  assert.equal(fake.state.binds.length, 1)
})

test('an allowlisted account with a wrong password is rejected as invalid credentials', async () => {
  const { url } = await startAuthedApp()
  const login = await request(`${url}/api/auth/login`, {
    method: 'POST',
    body: { username: 'alice', password: 'wrong-password' }
  })
  assert.equal(login.response.status, 401)
  assert.equal(login.body.error.code, 'invalid_credentials')
})

test('a valid credential outside the allowlist is refused without leaking existence to anonymous callers', async () => {
  const { url } = await startAuthedApp({ allowlist: 'someoneelse\n' })
  const login = await request(`${url}/api/auth/login`, {
    method: 'POST',
    body: { username: 'alice', password: 'alice-secret' }
  })
  assert.equal(login.response.status, 403)
  assert.equal(login.body.error.code, 'account_not_authorized')

  // Precedence check: a wrong credential must still look like a credential
  // failure, never like an allowlist failure.
  const wrong = await request(`${url}/api/auth/login`, {
    method: 'POST',
    body: { username: 'alice', password: 'wrong-password' }
  })
  assert.equal(wrong.response.status, 401)
  assert.equal(wrong.body.error.code, 'invalid_credentials')
})

test('an empty allowlist denies everyone instead of opening access', async () => {
  const { url } = await startAuthedApp({ allowlist: '# only a comment\n' })
  const login = await request(`${url}/api/auth/login`, {
    method: 'POST',
    body: { username: 'alice', password: 'alice-secret' }
  })
  assert.equal(login.response.status, 403)
  assert.equal(login.body.error.code, 'account_not_authorized')
})

test('removing an account from the allowlist invalidates its live session', async () => {
  const { url, allowlistPath, auth } = await startAuthedApp()
  const login = await request(`${url}/api/auth/login`, {
    method: 'POST',
    body: { username: 'alice', password: 'alice-secret' }
  })
  const cookie = cookieFrom(login.response)
  assert.equal((await request(`${url}/api/candidates`, { headers: { cookie } })).response.status, 200)

  writeFileSync(allowlistPath, '# empty\n', 'utf8')
  auth.allowlist.lastLoadedAt = 0
  auth.allowlist.reloadIfStale()

  const afterRemoval = await request(`${url}/api/candidates`, { headers: { cookie } })
  assert.equal(afterRemoval.response.status, 403)
  assert.equal(afterRemoval.body.error.code, 'account_not_authorized')
})

test('logout revokes the session and clears the cookie', async () => {
  const { url } = await startAuthedApp()
  const login = await request(`${url}/api/auth/login`, {
    method: 'POST',
    body: { username: 'alice', password: 'alice-secret' }
  })
  const cookie = cookieFrom(login.response)
  const logout = await request(`${url}/api/auth/logout`, { method: 'POST', headers: { cookie } })
  assert.equal(logout.response.status, 204)
  assert.match(logout.response.headers.get('set-cookie'), /workbench_session=;/)

  const after = await request(`${url}/api/candidates`, { headers: { cookie } })
  assert.equal(after.response.status, 401)
  // The revoked token no longer maps to a session row, so it is reported as a
  // missing session rather than an expired one. Both mean "log in again".
  assert.equal(after.body.error.code, 'authentication_required')
})

test('repeated failures lock the account but leave other accounts on the same address usable', async () => {
  // Two accounts behind one source address: the per-account lockout must not
  // take the whole office down with it.
  const { url } = await startAuthedApp({
    allowlist: 'alice\nbob\n',
    env: { AUTH_LOGIN_RATE_LIMIT: '2' },
    fakeClient: {
      users: {
        alice: { password: 'alice-secret', cn: 'Alice', mail: 'alice@example.test' },
        bob: { password: 'bob-secret', cn: 'Bob', mail: 'bob@example.test' }
      }
    }
  })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const failure = await request(`${url}/api/auth/login`, {
      method: 'POST',
      body: { username: 'alice', password: 'wrong-password' }
    })
    assert.equal(failure.response.status, 401)
  }
  const locked = await request(`${url}/api/auth/login`, {
    method: 'POST',
    body: { username: 'alice', password: 'alice-secret' }
  })
  assert.equal(locked.response.status, 429)
  assert.equal(locked.body.error.code, 'auth_rate_limited')
  assert.ok(Number(locked.response.headers.get('retry-after')) > 0)

  const otherAccount = await request(`${url}/api/auth/login`, {
    method: 'POST',
    body: { username: 'bob', password: 'bob-secret' }
  })
  assert.equal(otherAccount.response.status, 200)
  assert.equal(otherAccount.body.user.username, 'bob')
})

test('session endpoint reports the current user and expires_at', async () => {
  const { url } = await startAuthedApp()
  const login = await request(`${url}/api/auth/login`, {
    method: 'POST',
    body: { username: 'alice', password: 'alice-secret' }
  })
  const cookie = cookieFrom(login.response)
  const session = await request(`${url}/api/auth/session`, { headers: { cookie } })
  assert.equal(session.response.status, 200)
  assert.equal(session.body.user.username, 'alice')
  assert.ok(session.body.expires_at)

  const anonymous = await request(`${url}/api/auth/session`)
  assert.equal(anonymous.response.status, 401)
})

test('auth disabled keeps the previous behaviour: no login required', async () => {
  const app = createApp({ databasePath: ':memory:' })
  const db = app.locals.db
  insertCandidate(db, { name: '匿名候选人' })
  const running = await listen(app)
  cleanups.push(async () => app.closeDatabase())

  const candidates = await request(`${running.url}/api/candidates`)
  assert.equal(candidates.response.status, 200)
  assert.equal(candidates.body.items.length, 1)

  const status = await request(`${running.url}/api/auth/status`)
  assert.equal(status.response.status, 404)
})
