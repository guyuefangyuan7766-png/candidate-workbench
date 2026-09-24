import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthService } from '../../server/auth/index.js'
import { createFakeLdapClient } from './ldap-fake-client.mjs'

/**
 * Regression guard for the session cookie lifetime.
 *
 * Express 5 takes `maxAge` in MILLISECONDS and writes `Max-Age` after dividing
 * by 1000. The login handler used to pass seconds, which silently produced a
 * cookie that expired in 43 seconds instead of 12 hours — every user was
 * bounced back to the login page after a few clicks.
 */
test('the session cookie is issued with the configured lifetime, not a truncated one', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anonymous-cookie-maxage-'))
  const allowlist = join(directory, 'allow.txt')
  writeFileSync(allowlist, 'alice\n', 'utf8')

  const auth = createAuthService({
    env: {
      AUTH_ENABLED: 'true',
      LDAP_URL: 'ldap://ldap.example.test:389',
      LDAP_USER_DN_TEMPLATE: 'cn=%s,ou=People,dc=example,dc=test',
      AUTH_ALLOWLIST_FILE: allowlist
    },
    databasePath: ':memory:',
    authDatabasePath: ':memory:',
    createLdapClient: () => createFakeLdapClient({}).create(),
    logger: { warn() {}, log() {} }
  })

  const app = express()
  app.use(express.json())
  app.post('/api/auth/login', auth.middleware.loginHandler)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'alice-secret' })
    })
    assert.equal(response.status, 200)

    const setCookie = response.headers.getSetCookie().join('; ')
    const maxAge = /Max-Age=(\d+)/i.exec(setCookie)
    const expires = /Expires=([^;]+)/i.exec(setCookie)
    assert.ok(maxAge, `Set-Cookie 里必须有 Max-Age：${setCookie}`)
    assert.equal(Number(maxAge[1]), 43_200, 'Max-Age 必须是 12 小时（43200 秒），不能是被截断的 43')
    assert.ok(Number(maxAge[1]) > 3_600, 'Max-Age 不能小于 1 小时')
    assert.ok(expires, 'Set-Cookie 里必须有 Expires')
    const expiresInHours = (new Date(expires[1]).getTime() - Date.now()) / 3_600_000
    assert.ok(expiresInHours > 11 && expiresInHours < 13, `Expires 应约为 12 小时后，实际 ${expiresInHours.toFixed(2)} 小时`)
    assert.match(setCookie, /HttpOnly/i)
    assert.match(setCookie, /SameSite=Lax/i)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    auth.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
