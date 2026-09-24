import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthService } from '../../server/auth/index.js'
import { createFakeLdapClient } from './ldap-fake-client.mjs'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'anonymous-auth-diag-'))
  const allowlist = join(directory, 'allow.txt')
  writeFileSync(allowlist, 'alice\n', 'utf8')
  const warnings = []
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
    logger: { warn: (message) => warnings.push(message), log: () => {} },
    diagnostics: true
  })
  return { auth, warnings, directory }
}

test('auth diagnostics distinguish a missing cookie from an invalid token', () => {
  const { auth, warnings, directory } = fixture()
  try {
    const request = { headers: {}, path: '/api/candidates', method: 'GET' }
    assert.equal(auth.middleware.resolveRequestSession(request).error.code, 'authentication_required')
    assert.match(warnings[0], /reason=missing-cookie/)
    assert.match(warnings[0], /token=absent/)
    assert.match(warnings[0], /headerCookies=\[\(no Cookie header\)\]/)

    request.headers.cookie = 'other=1'
    auth.middleware.resolveRequestSession(request)
    assert.match(warnings[1], /reason=missing-cookie/)
    // The diagnostic lists the cookies that did arrive, which is the evidence
    // needed to tell "browser dropped our cookie" from "cookie was never set".
    assert.match(warnings[1], /headerCookies=\[other\]/)

    request.headers.cookie = 'workbench_session=0123456789abcdef0123456789abcdef'
    auth.middleware.resolveRequestSession(request)
    assert.match(warnings[2], /reason=session-missing/)
    assert.match(warnings[2], /token=32 chars/)
  } finally {
    auth.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('auth diagnostics are silent when AUTH_DEBUG is not enabled', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anonymous-auth-quiet-'))
  const allowlist = join(directory, 'allow.txt')
  writeFileSync(allowlist, 'alice\n', 'utf8')
  const warnings = []
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
    logger: { warn: (message) => warnings.push(message), log: () => {} }
  })
  try {
    auth.middleware.resolveRequestSession({ headers: {}, path: '/api/x', method: 'GET' })
    assert.equal(warnings.length, 0)
  } finally {
    auth.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
