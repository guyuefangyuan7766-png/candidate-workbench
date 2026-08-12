import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.js'
import { insertCandidate } from '../../server/candidates.js'

async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers)
  if (options.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const response = await fetch(url, {
    ...options,
    headers,
    body: options.body !== undefined && typeof options.body !== 'string'
      ? JSON.stringify(options.body)
      : options.body
  })
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}

test('position permanent-delete HTTP flow is token-bound, atomic, and preserves candidate-owned data', async () => {
  const app = createApp({ databasePath: ':memory:' })
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    const candidate = insertCandidate(app.locals.db, {
      id: 'anonymous-position-delete-candidate',
      name: 'Anonymous Position Candidate',
      email: 'position-delete@example.test'
    })
    const note = await requestJson(`${url}/api/candidates/${candidate.id}/notes`, {
      method: 'POST',
      body: { content: 'Anonymous candidate-owned note' }
    })
    assert.equal(note.response.status, 201)

    const positions = []
    for (const title of ['Anonymous Position One', 'Anonymous Position Two', 'Anonymous Position Single']) {
      const created = await requestJson(`${url}/api/positions`, {
        method: 'POST',
        body: { title, status: 'open', headcount: 1 }
      })
      assert.equal(created.response.status, 201)
      positions.push(created.body)
    }
    const linkedAt = new Date().toISOString()
    app.locals.db.prepare(`
      INSERT INTO candidate_positions(candidate_id, position_id, created_at)
      VALUES (?, ?, ?), (?, ?, ?)
    `).run(candidate.id, positions[0].id, linkedAt, candidate.id, positions[1].id, linkedAt)

    const activePreview = await requestJson(`${url}/api/positions/permanent-delete/preview`, {
      method: 'POST',
      body: { position_ids: [positions[0].id] }
    })
    assert.equal(activePreview.response.status, 409)
    assert.equal(activePreview.body.error.code, 'position_not_archived')

    for (const position of positions) {
      const archived = await requestJson(`${url}/api/positions/${position.id}/archive`, { method: 'POST' })
      assert.equal(archived.response.status, 200)
    }

    const batchPreview = await requestJson(`${url}/api/positions/permanent-delete/preview`, {
      method: 'POST',
      body: { position_ids: [positions[1].id, positions[0].id] }
    })
    assert.equal(batchPreview.response.status, 200)
    assert.equal(batchPreview.body.position_count, 2)
    assert.equal(batchPreview.body.affected_candidate_count, 1)
    const batchCommit = await requestJson(`${url}/api/positions/permanent-delete/commit`, {
      method: 'POST',
      body: { preview_token: batchPreview.body.preview_token }
    })
    assert.equal(batchCommit.response.status, 200)
    assert.equal(batchCommit.body.deleted_count, 2)
    assert.equal(batchCommit.body.candidate_activity_count, 1)

    const singlePreview = await requestJson(`${url}/api/positions/${positions[2].id}/permanent-delete/preview`, {
      method: 'POST'
    })
    assert.equal(singlePreview.response.status, 200)
    const singleCommit = await requestJson(`${url}/api/positions/${positions[2].id}/permanent-delete`, {
      method: 'POST',
      body: { preview_token: singlePreview.body.preview_token }
    })
    assert.equal(singleCommit.response.status, 200)
    assert.equal(singleCommit.body.position_id, positions[2].id)

    const candidateDetail = await requestJson(`${url}/api/candidates/${candidate.id}?include_sensitive=true`)
    assert.equal(candidateDetail.response.status, 200)
    assert.equal(candidateDetail.body.email, 'position-delete@example.test')
    assert.equal(candidateDetail.body.notes.some((item) => item.content === 'Anonymous candidate-owned note'), true)
    assert.equal(candidateDetail.body.activities.some((item) => item.type === 'position_permanently_deleted'), true)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM positions').get().count, 0)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count, 1)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 1)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM position_deletion_audits').get().count, 3)
    assert.deepEqual(app.locals.db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    app.closeDatabase()
  }
})
