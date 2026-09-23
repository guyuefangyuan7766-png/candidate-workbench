import test from 'node:test'
import assert from 'node:assert/strict'
import { ServerAuthStore } from '../../server/auth/store.js'
import {
  createLdapAuthenticator,
  buildUserDn,
  escapeDnValue,
  normalizeLoginIdentifier,
  AUTH_ERROR_CODES
} from '../../server/auth/ldap.js'
import { createFakeLdapClient } from './ldap-fake-client.mjs'

function baseConfig(overrides = {}) {
  return {
    url: 'ldap://ldap.example.test:389',
    host: 'ldap.example.test',
    protocol: 'ldap',
    encrypted: false,
    startTls: false,
    allowPlaintext: true,
    userDnTemplate: 'cn=%s,ou=People,dc=example,dc=test',
    uidAttribute: 'uid',
    nameAttributes: ['cn'],
    emailAttribute: 'mail',
    attributeLookup: 'off',
    searchBase: 'ou=People,dc=example,dc=test',
    userFilter: '(uid={username})',
    bindDn: '',
    bindPassword: '',
    timeoutMs: 5_000,
    ...overrides
  }
}

function fixture(options = {}) {
  const store = new ServerAuthStore({ databasePath: ':memory:' })
  const fake = createFakeLdapClient(options.fakeClient ?? {})
  const authenticator = createLdapAuthenticator({
    config: baseConfig(options.config),
    store,
    createClient: () => fake.create(),
    logger: { warn() {} }
  })
  return { store, fake, authenticator }
}

test('DN values are escaped so a username cannot change the DN structure', () => {
  assert.equal(escapeDnValue('zhangsan'), 'zhangsan')
  assert.equal(escapeDnValue('a,b'), 'a\\2cb')
  assert.equal(escapeDnValue('a+b'), 'a\\2bb')
  assert.equal(escapeDnValue('a\\b'), 'a\\5cb')
  assert.equal(escapeDnValue(' a'), '\\20a')
  assert.equal(escapeDnValue('a '), 'a\\20')
  assert.equal(
    buildUserDn('cn=%s,ou=People,dc=example,dc=test', 'a,b'),
    'cn=a\\2cb,ou=People,dc=example,dc=test'
  )
})

test('login identifiers are trimmed and stripped of a domain prefix', () => {
  assert.equal(normalizeLoginIdentifier('  zhangsan '), 'zhangsan')
  assert.equal(normalizeLoginIdentifier('WOODUAN\\zhangsan'), 'zhangsan')
  assert.equal(normalizeLoginIdentifier(''), '')
  assert.equal(normalizeLoginIdentifier('x'.repeat(400)).length, 200)
})

test('direct binding authenticates a valid account and records the session', async () => {
  const { store, fake, authenticator } = fixture()
  const result = await authenticator.authenticate({
    username: 'alice',
    password: 'alice-secret',
    session: { ttlMs: 60_000, absoluteTtlMs: 120_000 }
  })
  assert.equal(result.user.username, 'alice')
  // Attribute lookup is off by default, so the display name falls back to the
  // confirmed first-version behaviour: show the login identifier.
  assert.equal(result.user.display_name, 'alice')
  assert.equal(fake.state.binds.length, 1)
  assert.equal(fake.state.binds[0].dn, 'cn=alice,ou=People,dc=example,dc=test')
  assert.equal(fake.state.searches, 0)
  assert.equal(fake.state.unbound, 1)
  assert.equal(store.resolveSession(result.session.token, { ttlMs: 60_000, absoluteTtlMs: 120_000 }).status, 'active')
})

test('a wrong password and an unknown account produce the same invalid_credentials error', async () => {
  const { authenticator } = fixture()
  await assert.rejects(
    () => authenticator.authenticate({ username: 'alice', password: 'wrong', session: { ttlMs: 1_000, absoluteTtlMs: 2_000 } }),
    (error) => error.status === 401 && error.code === AUTH_ERROR_CODES.INVALID_CREDENTIALS
  )
  await assert.rejects(
    () => authenticator.authenticate({ username: 'nobody', password: 'whatever', session: { ttlMs: 1_000, absoluteTtlMs: 2_000 } }),
    (error) => error.status === 401 && error.code === AUTH_ERROR_CODES.INVALID_CREDENTIALS
  )
})

test('directory outages and timeouts map to auth_backend_unavailable', async () => {
  const timeout = Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' })
  const { authenticator } = fixture({ fakeClient: { behavior: { bindError: timeout } } })
  await assert.rejects(
    () => authenticator.authenticate({ username: 'alice', password: 'x', session: { ttlMs: 1_000, absoluteTtlMs: 2_000 } }),
    (error) => error.status === 503 && error.code === AUTH_ERROR_CODES.BACKEND_UNAVAILABLE
  )

  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  const second = fixture({ fakeClient: { behavior: { bindError: refused } } })
  await assert.rejects(
    () => second.authenticator.authenticate({ username: 'alice', password: 'x', session: { ttlMs: 1_000, absoluteTtlMs: 2_000 } }),
    (error) => error.status === 503 && error.code === AUTH_ERROR_CODES.BACKEND_UNAVAILABLE
  )
})

test('anonymous attribute lookup fills display name and email when allowed', async () => {
  const { authenticator, fake } = fixture({ config: { attributeLookup: 'anonymous' } })
  const result = await authenticator.authenticate({
    username: 'alice',
    password: 'alice-secret',
    session: { ttlMs: 60_000, absoluteTtlMs: 120_000 }
  })
  assert.equal(fake.state.searches, 1)
  assert.equal(result.user.display_name, 'Alice')
  assert.equal(result.user.email, 'alice@example.test')
})

test('attribute lookup failures never turn a successful bind into a failed login', async () => {
  const denied = Object.assign(new Error('insufficient access rights'), { code: 50 })
  const { authenticator } = fixture({
    config: { attributeLookup: 'anonymous' },
    fakeClient: { behavior: { searchError: denied } }
  })
  const result = await authenticator.authenticate({
    username: 'alice',
    password: 'alice-secret',
    session: { ttlMs: 60_000, absoluteTtlMs: 120_000 }
  })
  assert.equal(result.user.username, 'alice')
  assert.equal(result.user.display_name, 'alice')
  assert.equal(result.user.email, null)
})

test('empty or oversized credentials are rejected as validation errors', async () => {
  const { authenticator } = fixture()
  const session = { ttlMs: 1_000, absoluteTtlMs: 2_000 }
  await assert.rejects(
    () => authenticator.authenticate({ username: '', password: 'x', session }),
    (error) => error.status === 422 && error.code === 'validation_error'
  )
  await assert.rejects(
    () => authenticator.authenticate({ username: 'alice', password: '', session }),
    (error) => error.status === 422 && error.code === 'validation_error'
  )
  await assert.rejects(
    () => authenticator.authenticate({ username: 'alice', password: 'x'.repeat(600), session }),
    (error) => error.status === 422 && error.code === 'validation_error'
  )
})

