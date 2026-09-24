import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerAuthStore, hashSessionToken, normalizeUsername, readCookie } from '../../server/auth/store.js'

async function withStore(body) {
  const directory = mkdtempSync(join(tmpdir(), 'anonymous-auth-store-'))
  const store = new ServerAuthStore({ databasePath: join(directory, 'auth.db') })
  try {
    await body(store, directory)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

test('auth store creates its own schema outside the business migration ledger', async () => {
  await withStore(async (store) => {
    const tables = store.db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'auth_%' ORDER BY name")
      .all()
      .map((row) => row.name)
    assert.deepEqual(tables, ['auth_meta', 'auth_sessions', 'auth_users'])
    const version = store.db.prepare("SELECT value FROM auth_meta WHERE key = 'schema_version'").get()
    assert.equal(version.value, '1')
    assert.equal(store.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'schema_migrations'").get(), undefined)
  })
})

test('auth store upserts users and never stores a password derivative', async () => {
  await withStore(async (store) => {
    const created = store.upsertUser({
      username: 'Alice',
      ldapDn: 'cn=alice,ou=People,dc=example,dc=test',
      displayName: 'Alice',
      email: 'alice@example.test'
    })
    assert.equal(created.username, 'alice')
    assert.equal(store.findUserByUsername('ALICE').display_name, 'Alice')

    const updated = store.upsertUser({
      username: 'alice',
      ldapDn: 'cn=alice,ou=People,dc=example,dc=test',
      displayName: 'Alice Updated',
      email: 'alice2@example.test'
    })
    assert.equal(updated.id, created.id)
    assert.equal(updated.display_name, 'Alice Updated')
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM auth_users').get().count, 1)

    const columns = store.db.prepare('PRAGMA table_info(auth_users)').all().map((row) => row.name)
    assert.equal(columns.some((name) => /password/i.test(name)), false)
  })
})

test('sessions store only a token hash and resolve through sliding expiry', async () => {
  await withStore(async (store) => {
    const user = store.upsertUser({ username: 'alice', ldapDn: 'cn=alice', displayName: 'Alice' })
    const session = store.createSession({
      userId: user.id,
      ttlMs: 60_000,
      absoluteTtlMs: 120_000,
      userAgent: 'anonymous-agent',
      clientIp: '10.0.0.1'
    })
    const row = store.db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(session.id)
    assert.equal(row.token_hash, hashSessionToken(session.token))
    assert.notEqual(row.token_hash, session.token)
    assert.equal(JSON.stringify(row).includes(session.token), false)

    const resolved = store.resolveSession(session.token, { ttlMs: 60_000, absoluteTtlMs: 120_000 })
    assert.equal(resolved.status, 'active')
    assert.equal(resolved.user.username, 'alice')
    // Regression: the session row and the user row both carry an `id` column.
    // A `SELECT s.*` join silently substituted the session id for the user id
    // and made every resumed session resolve to a non-existent user.
    assert.equal(resolved.user.id, user.id)
    assert.notEqual(resolved.user.id, session.id)
    assert.equal(resolved.session.id, session.id)
    assert.equal(store.findUserById(resolved.user.id)?.username, 'alice')

    assert.equal(store.resolveSession('0'.repeat(64), { ttlMs: 60_000, absoluteTtlMs: 120_000 }).status, 'missing')
  })
})

test('sessions expire on the absolute deadline even while active', async () => {
  await withStore(async (store) => {
    const user = store.upsertUser({ username: 'alice', ldapDn: 'cn=alice' })
    const session = store.createSession({ userId: user.id, ttlMs: 60_000, absoluteTtlMs: 60_000 })
    store.db
      .prepare('UPDATE auth_sessions SET absolute_expires_at = ?, expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), new Date(Date.now() + 60_000).toISOString(), session.id)
    assert.equal(store.resolveSession(session.token, { ttlMs: 60_000, absoluteTtlMs: 60_000 }).status, 'expired')
  })
})

test('revocation is immediate and scoped to the requested session or user', async () => {
  await withStore(async (store) => {
    const alice = store.upsertUser({ username: 'alice', ldapDn: 'cn=alice' })
    const bob = store.upsertUser({ username: 'bob', ldapDn: 'cn=bob' })
    const first = store.createSession({ userId: alice.id, ttlMs: 60_000, absoluteTtlMs: 60_000 })
    const second = store.createSession({ userId: alice.id, ttlMs: 60_000, absoluteTtlMs: 60_000 })
    const bobs = store.createSession({ userId: bob.id, ttlMs: 60_000, absoluteTtlMs: 60_000 })

    assert.equal(store.revokeSession(first.token), true)
    assert.equal(store.resolveSession(first.token, { ttlMs: 60_000, absoluteTtlMs: 60_000 }).status, 'revoked')
    assert.equal(store.resolveSession(second.token, { ttlMs: 60_000, absoluteTtlMs: 60_000 }).status, 'active')

    assert.equal(store.revokeAllForUser('alice'), 1)
    assert.equal(store.resolveSession(second.token, { ttlMs: 60_000, absoluteTtlMs: 60_000 }).status, 'revoked')
    assert.equal(store.resolveSession(bobs.token, { ttlMs: 60_000, absoluteTtlMs: 60_000 }).status, 'active')
  })
})

test('cleanup removes expired sessions and keeps live ones', async () => {
  await withStore(async (store) => {
    const user = store.upsertUser({ username: 'alice', ldapDn: 'cn=alice' })
    const live = store.createSession({ userId: user.id, ttlMs: 600_000, absoluteTtlMs: 600_000 })
    const dead = store.createSession({ userId: user.id, ttlMs: 600_000, absoluteTtlMs: 600_000 })
    store.db
      .prepare('UPDATE auth_sessions SET expires_at = ?, absolute_expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), new Date(Date.now() - 1_000).toISOString(), dead.id)
    assert.equal(store.cleanupExpired(), 1)
    assert.equal(store.countActiveSessions(), 1)
    assert.equal(store.resolveSession(live.token, { ttlMs: 600_000, absoluteTtlMs: 600_000 }).status, 'active')
  })
})

test('username normalization and cookie parsing handle domain prefixes and encoding', () => {
  assert.equal(normalizeUsername('  WOODUAN\\ZhangSan '), 'zhangsan')
  assert.equal(normalizeUsername('zhangsan@example.test'), 'zhangsan@example.test')
  assert.equal(readCookie('a=1; workbench_session=abc%2Fdef; b=2', 'workbench_session'), 'abc/def')
  assert.equal(readCookie('', 'workbench_session'), '')
  assert.equal(readCookie('other=1', 'workbench_session'), '')
})

test('session token hashing is a stable sha256 digest', () => {
  assert.equal(hashSessionToken('abc'), createHash('sha256').update('abc').digest('hex'))
})
