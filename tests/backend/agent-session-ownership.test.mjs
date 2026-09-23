import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase } from '../../server/database.js'
import { createAgentSessionService } from '../../server/agent-sessions.js'

const USER_A = 'user-a'
const USER_B = 'user-b'

function fixture() {
  const db = openDatabase(':memory:')
  const sessions = createAgentSessionService(db)
  return { db, sessions }
}

test('a session is only visible to the user who created it', () => {
  const { db, sessions } = fixture()
  try {
    const a = sessions.createSession({ userId: USER_A, title: 'A 的对话' })
    const b = sessions.createSession({ userId: USER_B, title: 'B 的对话' })

    const listA = sessions.listSessions({ userId: USER_A })
    const listB = sessions.listSessions({ userId: USER_B })
    assert.deepEqual(listA.items.map((s) => s.id), [a.id])
    assert.deepEqual(listB.items.map((s) => s.id), [b.id])
    assert.equal(listA.pagination.total, 1)
    assert.equal(listB.pagination.total, 1)

    // Direct access by ID must not leak another user's session.
    assert.equal(sessions.getSession(a.id, USER_A).id, a.id)
    assert.throws(() => sessions.getSession(b.id, USER_A), (error) => error.status === 404 && error.code === 'agent_session_not_found')
  } finally {
    db.close()
  }
})

test('renaming, archiving and deleting another user session is rejected', () => {
  const { db, sessions } = fixture()
  try {
    const a = sessions.createSession({ userId: USER_A, title: '原件' })
    assert.throws(() => sessions.updateSession(a.id, { userId: USER_B, title: '被改名' }), (error) => error.status === 404)
    assert.throws(() => sessions.deleteSession(a.id, { userId: USER_B }), (error) => error.status === 404)
    // The owner's session must be untouched.
    assert.equal(sessions.getSession(a.id, USER_A).title, '原件')
    assert.equal(sessions.listSessions({ userId: USER_A }).pagination.total, 1)

    sessions.updateSession(a.id, { userId: USER_A, title: '自己改名' })
    assert.equal(sessions.getSession(a.id, USER_A).title, '自己改名')
    sessions.deleteSession(a.id, { userId: USER_A })
    assert.equal(sessions.listSessions({ userId: USER_A }).pagination.total, 0)
  } finally {
    db.close()
  }
})

test('sessions created before ownership existed are invisible to everyone', () => {
  const { db, sessions } = fixture()
  try {
    // Simulate a row created by the pre-authentication code (no owner).
    db.prepare(`
      INSERT INTO agent_sessions(id, title, status, next_sequence, active_request_id, active_request_started_at, user_id, created_at, updated_at, archived_at)
      VALUES ('legacy-1', '历史对话', 'active', 1, NULL, NULL, NULL, ?, ?, NULL)
    `).run(new Date().toISOString(), new Date().toISOString())

    assert.equal(sessions.listSessions({ userId: USER_A }).pagination.total, 0)
    assert.equal(sessions.listSessions({ userId: USER_B }).pagination.total, 0)
    assert.throws(() => sessions.getSession('legacy-1', USER_A), (error) => error.status === 404)

    // A session created without an explicit owner is also not shared: it must be
    // created with a sentinel owner rather than NULL, otherwise it would land in
    // the invisible "legacy" bucket.
    const implicit = sessions.createSession({ title: '无显式归属' })
    assert.equal(sessions.listSessions({ userId: USER_A }).pagination.total, 0)
    assert.equal(sessions.listSessions({ userId: USER_B }).pagination.total, 0)
    assert.equal(db.prepare('SELECT user_id FROM agent_sessions WHERE id = ?').get(implicit.id).user_id, '__legacy__')
  } finally {
    db.close()
  }
})

test('messages and tasks are scoped to the session owner', () => {
  const { db, sessions } = fixture()
  try {
    const a = sessions.createSession({ userId: USER_A })

    // A user who does not own the session cannot read its messages or tasks.
    assert.throws(() => sessions.listMessages(a.id, { userId: USER_B }), (error) => error.status === 404)
    assert.throws(() => sessions.listTasks(a.id, { userId: USER_B }), (error) => error.status === 404)

    const owner = sessions.listMessages(a.id, { userId: USER_A })
    assert.ok(Array.isArray(owner.items))
    const tasks = sessions.listTasks(a.id, { userId: USER_A })
    assert.ok(Array.isArray(tasks.items))
  } finally {
    db.close()
  }
})
