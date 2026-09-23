import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp } from '../../server/app.js'
import { insertCandidate } from '../../server/candidates.js'
import { openDatabase } from '../../server/database.js'

async function withApp(run, options = {}) {
  const app = createApp({ databasePath: ':memory:', ...options })
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  try {
    await run({
      app,
      db: app.locals.db,
      url: `http://127.0.0.1:${server.address().port}`
    })
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await app.closeDatabase()
  }
}

async function withMockAgent(run) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push(JSON.parse(body))
    const payload = requests.length === 1
      ? {
          model: 'test-model',
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'deleted-candidate-check',
                type: 'function',
                function: {
                  name: 'get_candidate_full',
                  arguments: JSON.stringify({ candidate_id: 'candidate-agent-delete-target' })
                }
              }]
            }
          }]
        }
      : {
          model: 'test-model',
          choices: [{ message: { role: 'assistant', content: '候选人不存在。' } }]
        }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    await run({ requests, url: `http://127.0.0.1:${server.address().port}` })
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers)
  if (options.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
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

async function permanentlyDeleteCandidate(url, candidateId) {
  const preview = await requestJson(`${url}/api/candidates/${candidateId}/permanent-delete/preview`, {
    method: 'POST'
  })
  assert.equal(preview.response.status, 200)
  const deletion = await requestJson(`${url}/api/candidates/${candidateId}/permanent-delete`, {
    method: 'POST',
    body: { preview_token: preview.body.preview_token }
  })
  return { preview, deletion }
}

function archivedAt(db, candidateId) {
  return db.prepare('SELECT archived_at FROM candidates WHERE id = ?').get(candidateId)?.archived_at ?? null
}

function activityCount(db, candidateId, type) {
  return db.prepare(`
    SELECT COUNT(*) AS count FROM activities WHERE candidate_id = ? AND type = ?
  `).get(candidateId, type).count
}

test('batch archive validates IDs, is atomic, deduplicates input and blocks archived mutations', async () => {
  await withApp(async ({ db, url }) => {
    const activeOne = insertCandidate(db, { name: 'Batch Candidate One' })
    const activeTwo = insertCandidate(db, { name: 'Batch Candidate Two' })
    const alreadyArchived = insertCandidate(db, { name: 'Already Archived Candidate' })

    const empty = await requestJson(`${url}/api/candidates/archive-batch`, {
      method: 'POST',
      body: { candidate_ids: [] }
    })
    assert.equal(empty.response.status, 422)
    assert.equal(empty.body.error.code, 'validation_error')

    const oversized = await requestJson(`${url}/api/candidates/archive-batch`, {
      method: 'POST',
      body: { candidate_ids: Array.from({ length: 101 }, (_, index) => `candidate-${index}`) }
    })
    assert.equal(oversized.response.status, 413)
    assert.equal(oversized.body.error.code, 'limit_exceeded')

    const invalid = await requestJson(`${url}/api/candidates/archive-batch`, {
      method: 'POST',
      body: { candidate_ids: [activeOne.id, '   '] }
    })
    assert.equal(invalid.response.status, 422)
    assert.equal(invalid.body.error.code, 'validation_error')

    const archived = await requestJson(`${url}/api/candidates/${alreadyArchived.id}/archive`, { method: 'POST' })
    assert.equal(archived.response.status, 200)

    const missingConflict = await requestJson(`${url}/api/candidates/archive-batch`, {
      method: 'POST',
      body: { candidate_ids: [activeOne.id, 'missing-candidate'] }
    })
    assert.equal(missingConflict.response.status, 404)
    assert.equal(missingConflict.body.error.code, 'not_found')
    assert.equal(archivedAt(db, activeOne.id), null)
    assert.equal(activityCount(db, activeOne.id, 'candidate_archived'), 0)

    const stateConflict = await requestJson(`${url}/api/candidates/archive-batch`, {
      method: 'POST',
      body: { candidate_ids: [activeOne.id, alreadyArchived.id] }
    })
    assert.equal(stateConflict.response.status, 409)
    assert.equal(stateConflict.body.error.code, 'candidate_archived')
    assert.equal(archivedAt(db, activeOne.id), null)
    assert.equal(activityCount(db, activeOne.id, 'candidate_archived'), 0)

    const result = await requestJson(`${url}/api/candidates/archive-batch`, {
      method: 'POST',
      body: { candidate_ids: [activeOne.id, activeTwo.id, activeOne.id] }
    })
    assert.equal(result.response.status, 200)
    assert.deepEqual(result.body, {
      input_count: 3,
      requested_count: 2,
      duplicate_input_count: 1,
      archived_count: 2,
      archived_ids: [activeOne.id, activeTwo.id]
    })
    assert.ok(archivedAt(db, activeOne.id))
    assert.ok(archivedAt(db, activeTwo.id))
    assert.equal(activityCount(db, activeOne.id, 'candidate_archived'), 1)
    assert.equal(activityCount(db, activeTwo.id, 'candidate_archived'), 1)

    const relationshipTimestamp = '2026-08-04T00:00:00.000Z'
    const activeRelationshipCandidate = insertCandidate(db, { name: 'Active Relationship Candidate' })
    db.prepare(`
      INSERT INTO positions(id, title, headcount, status, tags, created_at, updated_at)
      VALUES ('archive-lock-position', 'Archive Lock Position', 1, 'open', '[]', ?, ?)
    `).run(relationshipTimestamp, relationshipTimestamp)
    db.prepare(`
      INSERT INTO talent_pools(id, name, color, created_at, updated_at)
      VALUES ('archive-lock-pool', 'Archive Lock Pool', '#3370ff', ?, ?)
    `).run(relationshipTimestamp, relationshipTimestamp)
    db.prepare(`INSERT INTO candidate_positions(candidate_id, position_id, created_at) VALUES (?, 'archive-lock-position', ?)`)
      .run(activeOne.id, relationshipTimestamp)
    db.prepare(`INSERT INTO candidate_positions(candidate_id, position_id, created_at) VALUES (?, 'archive-lock-position', ?)`)
      .run(activeRelationshipCandidate.id, relationshipTimestamp)
    db.prepare(`INSERT INTO candidate_talent_pools(candidate_id, talent_pool_id, created_at) VALUES (?, 'archive-lock-pool', ?)`)
      .run(activeOne.id, relationshipTimestamp)

    const blockedBatchUnlink = await requestJson(`${url}/api/positions/archive-lock-position/candidates`, {
      method: 'DELETE',
      body: { candidate_ids: [activeRelationshipCandidate.id, activeOne.id] }
    })
    assert.equal(blockedBatchUnlink.response.status, 409)
    assert.equal(blockedBatchUnlink.body.error.code, 'candidate_archived')
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM candidate_positions WHERE position_id = 'archive-lock-position'`).get().count,
      2,
      'a mixed batch must not remove the active candidate relation'
    )

    const blockedRequests = [
      requestJson(`${url}/api/candidates/${activeOne.id}`, {
        method: 'PATCH',
        body: { location: 'Blocked update' }
      }),
      requestJson(`${url}/api/candidates/${activeOne.id}/notes`, {
        method: 'POST',
        body: { content: 'Blocked note' }
      }),
      requestJson(`${url}/api/candidates/${activeOne.id}/preferences`, {
        method: 'PUT',
        body: { desired_titles: ['Blocked preference'] }
      }),
      requestJson(`${url}/api/candidates/${activeOne.id}/profile-sections`, {
        method: 'PUT',
        body: []
      }),
      requestJson(`${url}/api/candidates/${activeOne.id}/archive`, { method: 'POST' }),
      requestJson(`${url}/api/positions/archive-lock-position/candidates/${activeOne.id}`, { method: 'DELETE' }),
      requestJson(`${url}/api/talent-pools/archive-lock-pool/candidates`, {
        method: 'DELETE',
        body: { candidate_ids: [activeOne.id] }
      })
    ]
    for (const blocked of await Promise.all(blockedRequests)) {
      assert.equal(blocked.response.status, 409)
      assert.equal(blocked.body.error.code, 'candidate_archived')
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notes WHERE candidate_id = ?').get(activeOne.id).count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidate_positions WHERE candidate_id = ?').get(activeOne.id).count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidate_talent_pools WHERE candidate_id = ?').get(activeOne.id).count, 1)
  })
})

test('permanent delete requires archive state and a current one-time preview token without a confirmation phrase', async () => {
  await withApp(async ({ db, url }) => {
    const candidate = insertCandidate(db, { name: 'Deletion Guard Candidate' })

    const activeDelete = await requestJson(`${url}/api/candidates/${candidate.id}/permanent-delete/preview`, {
      method: 'POST'
    })
    assert.equal(activeDelete.response.status, 409)
    assert.equal(activeDelete.body.error.code, 'candidate_not_archived')

    const archive = await requestJson(`${url}/api/candidates/${candidate.id}/archive`, { method: 'POST' })
    assert.equal(archive.response.status, 200)

    const missingToken = await requestJson(`${url}/api/candidates/${candidate.id}/permanent-delete`, {
      method: 'POST',
      body: {}
    })
    assert.equal(missingToken.response.status, 422)
    assert.equal(missingToken.body.error.code, 'validation_error')

    const preview = await requestJson(`${url}/api/candidates/${candidate.id}/permanent-delete/preview`, {
      method: 'POST'
    })
    assert.equal(preview.response.status, 200)
    db.prepare(`UPDATE candidates SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`).run(candidate.id)
    const staleVersion = await requestJson(`${url}/api/candidates/${candidate.id}/permanent-delete`, {
      method: 'POST',
      body: { preview_token: preview.body.preview_token }
    })
    assert.equal(staleVersion.response.status, 409)
    assert.equal(staleVersion.body.error.code, 'version_conflict')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidates WHERE id = ?').get(candidate.id).count, 1)

    const routeTarget = insertCandidate(db, { name: 'Route Token Target Candidate' })
    const routeOther = insertCandidate(db, { name: 'Route Other Candidate' })
    await requestJson(`${url}/api/candidates/${routeTarget.id}/archive`, { method: 'POST' })
    await requestJson(`${url}/api/candidates/${routeOther.id}/archive`, { method: 'POST' })
    const routePreview = await requestJson(`${url}/api/candidates/${routeTarget.id}/permanent-delete/preview`, {
      method: 'POST'
    })
    const mismatchedRoute = await requestJson(`${url}/api/candidates/${routeOther.id}/permanent-delete`, {
      method: 'POST',
      body: { preview_token: routePreview.body.preview_token }
    })
    assert.equal(mismatchedRoute.response.status, 409)
    assert.equal(mismatchedRoute.body.error.code, 'deletion_preview_target_mismatch')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidates WHERE id IN (?, ?)').get(routeTarget.id, routeOther.id).count, 2)

    const deletable = insertCandidate(db, { name: 'No Confirmation Phrase Candidate' })
    const deletableArchive = await requestJson(`${url}/api/candidates/${deletable.id}/archive`, { method: 'POST' })
    assert.equal(deletableArchive.response.status, 200)
    const { deletion } = await permanentlyDeleteCandidate(url, deletable.id)
    assert.equal(deletion.response.status, 200)
    assert.equal(deletion.body.candidate_id, deletable.id)
  })
})

test('permanent delete cascades candidate-owned data and retains shared records with a PII-free audit', async () => {
  await withApp(async ({ db, url }) => {
    const timestamp = '2026-08-04T00:00:00.000Z'
    const importBatchId = 'shared-import-batch'
    const positionId = 'shared-position'
    const talentPoolId = 'shared-talent-pool'
    const candidateId = 'candidate-permanent-delete-target'
    const pii = {
      name: 'Sensitive Candidate Name',
      phone: '13800138000',
      email: 'sensitive@example.test'
    }

    db.prepare(`
      INSERT INTO import_batches(
        id, filename, sheet_name, total_rows, imported_rows, updated_rows,
        skipped_rows, failed_rows, status, created_at, completed_at
      ) VALUES (?, 'source.xlsx', 'Candidates', 1, 1, 0, 0, 0, 'completed', ?, ?)
    `).run(importBatchId, timestamp, timestamp)
    db.prepare(`
      INSERT INTO positions(id, title, headcount, status, tags, created_at, updated_at)
      VALUES (?, 'Shared Position', 1, 'open', '[]', ?, ?)
    `).run(positionId, timestamp, timestamp)
    db.prepare(`
      INSERT INTO talent_pools(id, name, description, color, created_at, updated_at)
      VALUES (?, 'Shared Talent Pool', NULL, '#2563eb', ?, ?)
    `).run(talentPoolId, timestamp, timestamp)

    const survivor = insertCandidate(db, {
      id: 'candidate-shared-entity-survivor',
      name: 'Shared Entity Survivor'
    })

    const candidate = insertCandidate(db, {
      id: candidateId,
      ...pii,
      import_batch_id: importBatchId,
      source_system: 'legacy',
      source_record_id: 'legacy-sensitive-record'
    })

    db.prepare(`INSERT INTO notes(id, candidate_id, content, author, created_at, updated_at)
      VALUES ('owned-note', ?, 'Sensitive note', 'Tester', ?, ?)`
      ).run(candidate.id, timestamp, timestamp)
    db.prepare(`INSERT INTO candidate_positions(candidate_id, position_id, created_at) VALUES (?, ?, ?)`)
      .run(candidate.id, positionId, timestamp)
    db.prepare(`INSERT INTO candidate_talent_pools(candidate_id, talent_pool_id, created_at) VALUES (?, ?, ?)`)
      .run(candidate.id, talentPoolId, timestamp)
    db.prepare(`INSERT INTO candidate_positions(candidate_id, position_id, created_at) VALUES (?, ?, ?)`)
      .run(survivor.id, positionId, timestamp)
    db.prepare(`INSERT INTO candidate_talent_pools(candidate_id, talent_pool_id, created_at) VALUES (?, ?, ?)`)
      .run(survivor.id, talentPoolId, timestamp)
    db.prepare(`
      INSERT INTO candidate_profile_sections(
        id, candidate_id, section_type, title, content, structured_data,
        sort_order, sensitivity, source_record_id, created_at, updated_at, archived_at
      ) VALUES ('owned-profile', ?, 'experience', 'Experience', 'Sensitive profile', '{}', 0, 'high', NULL, ?, ?, NULL)
    `).run(candidate.id, timestamp, timestamp)
    db.prepare(`
      INSERT INTO candidate_preferences(
        candidate_id, employment_status, desired_titles, desired_locations,
        employment_type, expected_salary, availability, raw_payload, updated_at
      ) VALUES (?, 'available', '["Engineer"]', '["Shanghai"]', 'full_time', 'Sensitive salary', 'now', '{}', ?)
    `).run(candidate.id, timestamp)
    db.prepare(`
      INSERT INTO candidate_source_records(
        id, candidate_id, source_system, source_record_id, record_type, source_name,
        source_timestamp, raw_payload, sensitivity, created_at, updated_at
      ) VALUES ('owned-source', ?, 'legacy', 'owned-source-record', 'candidate', 'Legacy', ?, ?, 'high', ?, ?)
    `).run(candidate.id, timestamp, JSON.stringify(pii), timestamp, timestamp)
    db.prepare(`
      INSERT INTO candidate_assessments(
        id, candidate_id, position_id, assessment_type, title, status, score,
        conclusion, occurred_at, source_system, source_record_id, raw_payload,
        sensitivity, created_at, updated_at
      ) VALUES ('owned-assessment', ?, ?, 'review', 'Review', 'complete', 'A',
        'Sensitive conclusion', ?, 'legacy', 'owned-assessment-record', '{}', 'high', ?, ?)
    `).run(candidate.id, positionId, timestamp, timestamp, timestamp)
    db.prepare(`
      INSERT INTO candidate_consents(
        id, candidate_id, consent_type, status, agreement_name, consented_at,
        expires_at, source_system, source_record_id, raw_payload, sensitivity,
        created_at, updated_at
      ) VALUES ('owned-consent', ?, 'privacy', 'granted', 'Sensitive agreement', ?, NULL,
        'legacy', 'owned-consent-record', '{}', 'high', ?, ?)
    `).run(candidate.id, timestamp, timestamp, timestamp)
    db.prepare(`
      INSERT INTO candidate_position_sources(
        id, candidate_id, position_id, source_system, source_application_id,
        applied_at, raw_payload, sensitivity, created_at, updated_at
      ) VALUES ('owned-position-source', ?, ?, 'legacy', 'owned-application', ?, '{}', 'high', ?, ?)
    `).run(candidate.id, positionId, timestamp, timestamp, timestamp)

    const archive = await requestJson(`${url}/api/candidates/${candidate.id}/archive`, { method: 'POST' })
    assert.equal(archive.response.status, 200)

    const { deletion } = await permanentlyDeleteCandidate(url, candidate.id)
    assert.equal(deletion.response.status, 200)
    assert.equal(deletion.body.deleted, true)
    assert.equal(deletion.body.candidate_id, candidate.id)

    const allCandidates = await requestJson(`${url}/api/candidates?archived=include`)
    assert.equal(allCandidates.response.status, 200)
    assert.deepEqual(allCandidates.body.items.map((item) => item.id), [survivor.id])

    const deletedSearch = await requestJson(
      `${url}/api/candidates?archived=include&search=${encodeURIComponent(pii.name)}`
    )
    assert.equal(deletedSearch.response.status, 200)
    assert.equal(deletedSearch.body.pagination.total, 0)

    const dashboard = await requestJson(`${url}/api/dashboard`)
    assert.equal(dashboard.response.status, 200)
    assert.deepEqual(dashboard.body.totals, { total: 1, active: 1, archived: 0 })
    assert.equal(dashboard.body.recent_candidates.some((item) => item.id === candidate.id), false)
    assert.equal(dashboard.body.position_totals.total, 1)
    assert.equal(
      dashboard.body.talent_summary.by_pool.find((pool) => pool.id === talentPoolId)?.count,
      1
    )

    const exported = await fetch(`${url}/api/export?format=csv&archived=include`)
    assert.equal(exported.status, 200)
    const exportedText = Buffer.from(await exported.arrayBuffer()).toString('utf8')
    assert.equal(exportedText.includes(survivor.name), true)
    for (const sensitiveValue of [candidate.id, pii.name, pii.phone, pii.email]) {
      assert.equal(exportedText.includes(sensitiveValue), false)
    }

    const positionCandidates = await requestJson(
      `${url}/api/positions/${positionId}/candidates?archived=include`
    )
    assert.equal(positionCandidates.response.status, 200)
    assert.deepEqual(positionCandidates.body.items.map((item) => item.id), [survivor.id])

    const poolCandidates = await requestJson(
      `${url}/api/talent-pools/${talentPoolId}/candidates?archived=include`
    )
    assert.equal(poolCandidates.response.status, 200)
    assert.deepEqual(poolCandidates.body.items.map((item) => item.id), [survivor.id])

    const sharedPosition = await requestJson(`${url}/api/positions/${positionId}`)
    const sharedPool = await requestJson(`${url}/api/talent-pools/${talentPoolId}`)
    assert.equal(sharedPosition.response.status, 200)
    assert.equal(sharedPosition.body.candidate_count, 1)
    assert.equal(sharedPool.response.status, 200)
    assert.equal(sharedPool.body.candidate_count, 1)

    for (const table of [
      'candidates',
      'notes',
      'activities',
      'candidate_positions',
      'candidate_talent_pools',
      'candidate_profile_sections',
      'candidate_preferences',
      'candidate_source_records',
      'candidate_assessments',
      'candidate_consents',
      'candidate_position_sources'
    ]) {
      const count = table === 'candidates'
        ? db.prepare('SELECT COUNT(*) AS count FROM candidates WHERE id = ?').get(candidate.id).count
        : db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE candidate_id = ?`).get(candidate.id).count
      assert.equal(count, 0, `${table} must not retain candidate-owned rows`)
    }

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM positions WHERE id = ?').get(positionId).count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM talent_pools WHERE id = ?').get(talentPoolId).count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM import_batches WHERE id = ?').get(importBatchId).count, 1)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])

    const audit = db.prepare('SELECT * FROM deletion_audits WHERE id = ?').get(deletion.body.audit_id)
    assert.deepEqual(Object.keys(audit).sort(), ['candidate_id_hash', 'deleted_at', 'id'])
    assert.match(audit.candidate_id_hash, /^[a-f0-9]{64}$/)
    const serializedAudit = JSON.stringify(audit)
    for (const sensitiveValue of [candidate.id, pii.name, pii.phone, pii.email]) {
      assert.equal(serializedAudit.includes(sensitiveValue), false)
    }

    const deletedDetail = await requestJson(`${url}/api/candidates/${candidate.id}`)
    assert.equal(deletedDetail.response.status, 404)
  })
})

test('permanently deleted candidates are absent from Agent tool results', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-agent-deletion-'))
  try {
    await withMockAgent(async (mock) => {
      await withApp(async ({ db, url }) => {
        const candidate = insertCandidate(db, {
          id: 'candidate-agent-delete-target',
          name: 'Deleted Agent Candidate',
          email: 'deleted-agent@example.test'
        })
        const archive = await requestJson(`${url}/api/candidates/${candidate.id}/archive`, { method: 'POST' })
        assert.equal(archive.response.status, 200)
        const { deletion } = await permanentlyDeleteCandidate(url, candidate.id)
        assert.equal(deletion.response.status, 200)

        const query = await requestJson(`${url}/api/agent/query`, {
          method: 'POST',
          body: { message: '查询已删除候选人' }
        })
        assert.equal(query.response.status, 200)
        assert.equal(mock.requests.length, 2)
        const toolMessage = mock.requests[1].messages.find((message) => message.role === 'tool')
        const toolPayload = JSON.parse(toolMessage.content)
        assert.deepEqual(toolPayload.result, { error: 'candidate_not_found' })
        assert.equal(JSON.stringify(mock.requests[1]).includes('Deleted Agent Candidate'), false)
        assert.equal(JSON.stringify(mock.requests[1]).includes('deleted-agent@example.test'), false)
      }, {
        databasePath: join(directory, 'agent-deletion.db'),
        agentConfig: { baseUrl: `${mock.url}/v1`, apiKey: 'test-key', model: 'test-model' }
      })
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('deletion audit migration v5 is repeatable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-deletion-migration-'))
  const databasePath = join(directory, 'migration.db')
  try {
    let db = openDatabase(databasePath)
    db.close()
    db = openDatabase(databasePath)
    try {
      const migration = db.prepare('SELECT version, name FROM schema_migrations WHERE version = 5').all()
      assert.deepEqual(migration.map((row) => ({ ...row })), [
        { version: 5, name: 'candidate_deletion_audits' }
      ])
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'deletion_audits'").get().count,
        1
      )
      const columns = db.prepare('PRAGMA table_info(deletion_audits)').all().map((column) => column.name).sort()
      assert.deepEqual(columns, ['candidate_id_hash', 'deleted_at', 'id'])
    } finally {
      db.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
