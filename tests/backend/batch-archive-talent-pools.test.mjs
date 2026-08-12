import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.js'
import { archivePositions } from '../../server/positions.js'
import {
  archiveTalentPools,
  permanentlyDeleteTalentPools,
  restoreTalentPools
} from '../../server/talent.js'

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

async function startIsolatedApp() {
  const app = createApp({ databasePath: ':memory:' })
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    app,
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      app.closeDatabase()
    }
  }
}

async function createPosition(url, title) {
  const result = await requestJson(`${url}/api/positions`, {
    method: 'POST',
    body: { title, status: 'open' }
  })
  assert.equal(result.response.status, 201)
  return result.body
}

async function createPool(url, name) {
  const result = await requestJson(`${url}/api/talent-pools`, {
    method: 'POST',
    body: { name }
  })
  assert.equal(result.response.status, 201)
  return result.body
}

function records(items) {
  return items.map((item) => ({ id: item.id, expected_updated_at: item.updated_at }))
}

test('position batch archive is version-bound, limited, and atomic', async () => {
  const isolated = await startIsolatedApp()
  const { app, url } = isolated
  try {
    const first = await createPosition(url, 'Anonymous Batch Position One')
    const second = await createPosition(url, 'Anonymous Batch Position Two')
    const third = await createPosition(url, 'Anonymous Batch Position Three')

    const archived = await requestJson(`${url}/api/positions/archive-batch`, {
      method: 'POST',
      body: { records: records([first, second]) }
    })
    assert.equal(archived.response.status, 200)
    assert.equal(archived.body.updated_count, 2)
    assert.deepEqual(archived.body.updated_ids, [first.id, second.id])
    assert.ok(archived.body.items.every((item) => item.archived_at))
    assert.ok(archived.body.items.every((item, index) => item.updated_at !== [first, second][index].updated_at))

    const mixedState = await requestJson(`${url}/api/positions/archive-batch`, {
      method: 'POST',
      body: {
        records: [
          { id: third.id, expected_updated_at: third.updated_at },
          { id: first.id, expected_updated_at: archived.body.items[0].updated_at }
        ]
      }
    })
    assert.equal(mixedState.response.status, 409)
    assert.equal(mixedState.body.error.code, 'position_archive_conflict')
    assert.deepEqual(mixedState.body.error.details.already_archived_ids, [first.id])
    assert.equal(app.locals.db.prepare('SELECT archived_at FROM positions WHERE id = ?').get(third.id).archived_at, null)

    const fourth = await createPosition(url, 'Anonymous Batch Position Four')
    const fifth = await createPosition(url, 'Anonymous Batch Position Five')
    app.locals.db.prepare('UPDATE positions SET updated_at = ? WHERE id = ?')
      .run('2099-01-01T00:00:00.000Z', fifth.id)
    const stale = await requestJson(`${url}/api/positions/archive-batch`, {
      method: 'POST',
      body: { records: records([fourth, fifth]) }
    })
    assert.equal(stale.response.status, 409)
    assert.deepEqual(stale.body.error.details.version_conflict_ids, [fifth.id])
    assert.equal(app.locals.db.prepare('SELECT archived_at FROM positions WHERE id = ?').get(fourth.id).archived_at, null)

    const missing = await requestJson(`${url}/api/positions/archive-batch`, {
      method: 'POST',
      body: {
        records: [
          { id: third.id, expected_updated_at: third.updated_at },
          { id: 'missing-anonymous-position', expected_updated_at: third.updated_at }
        ]
      }
    })
    assert.equal(missing.response.status, 409)
    assert.deepEqual(missing.body.error.details.missing_ids, ['missing-anonymous-position'])
    assert.equal(app.locals.db.prepare('SELECT archived_at FROM positions WHERE id = ?').get(third.id).archived_at, null)

    const duplicate = await requestJson(`${url}/api/positions/archive-batch`, {
      method: 'POST',
      body: {
        records: [
          { id: third.id, expected_updated_at: third.updated_at },
          { id: third.id, expected_updated_at: third.updated_at }
        ]
      }
    })
    assert.equal(duplicate.response.status, 422)
    assert.equal(duplicate.body.error.code, 'validation_error')
    assert.equal(app.locals.db.prepare('SELECT archived_at FROM positions WHERE id = ?').get(third.id).archived_at, null)

    const oversized = await requestJson(`${url}/api/positions/archive-batch`, {
      method: 'POST',
      body: {
        records: Array.from({ length: 101 }, (_, index) => ({
          id: `anonymous-position-${index}`,
          expected_updated_at: '2026-01-01T00:00:00.000Z'
        }))
      }
    })
    assert.equal(oversized.response.status, 413)
    assert.equal(oversized.body.error.code, 'limit_exceeded')

    const rollbackOne = await createPosition(url, 'Anonymous Runtime Rollback Position One')
    const rollbackTwo = await createPosition(url, 'Anonymous Runtime Rollback Position Two')
    app.locals.db.exec(`
      CREATE TRIGGER anonymous_position_archive_abort
      BEFORE UPDATE OF archived_at ON positions
      WHEN OLD.id = '${rollbackTwo.id}' AND NEW.archived_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'anonymous forced position rollback');
      END;
    `)
    assert.throws(
      () => archivePositions(app.locals.db, records([rollbackOne, rollbackTwo])),
      /anonymous forced position rollback/
    )
    const rollbackRows = app.locals.db.prepare(`
      SELECT id, archived_at FROM positions WHERE id IN (?, ?) ORDER BY id
    `).all(rollbackOne.id, rollbackTwo.id)
    assert.equal(rollbackRows.length, 2)
    assert.ok(rollbackRows.every((row) => row.archived_at === null))
  } finally {
    await isolated.close()
  }
})

test('talent pool archive, restore, and permanent delete batches preserve candidate-owned data', async () => {
  const isolated = await startIsolatedApp()
  const { app, url } = isolated
  try {
    const candidate = await requestJson(`${url}/api/candidates`, {
      method: 'POST',
      body: {
        name: 'Anonymous Talent Pool Candidate',
        email: 'anonymous-pool-candidate@example.test'
      }
    })
    assert.equal(candidate.response.status, 201)
    const note = await requestJson(`${url}/api/candidates/${candidate.body.id}/notes`, {
      method: 'POST',
      body: { content: 'Anonymous candidate-owned note must survive pool deletion' }
    })
    assert.equal(note.response.status, 201)

    const position = await createPosition(url, 'Anonymous Candidate-Owned Position')
    const linkedPosition = await requestJson(`${url}/api/positions/${position.id}/candidates`, {
      method: 'POST',
      body: { candidate_ids: [candidate.body.id] }
    })
    assert.equal(linkedPosition.response.status, 201)
    const profileTimestamp = new Date().toISOString()
    app.locals.db.prepare(`
      INSERT INTO candidate_profile_sections(
        id, candidate_id, section_type, title, content, structured_data,
        sort_order, sensitivity, source_record_id, created_at, updated_at, archived_at
      ) VALUES (?, ?, 'experience', ?, ?, '{}', 0, 'internal', NULL, ?, ?, NULL)
    `).run(
      'anonymous-pool-preserved-profile',
      candidate.body.id,
      'Anonymous preserved experience',
      'Candidate resume content must survive talent pool deletion',
      profileTimestamp,
      profileTimestamp
    )

    const first = await createPool(url, 'Anonymous Batch Pool One')
    const second = await createPool(url, 'Anonymous Batch Pool Two')
    for (const pool of [first, second]) {
      const linked = await requestJson(`${url}/api/talent-pools/${pool.id}/candidates`, {
        method: 'POST',
        body: { candidate_ids: [candidate.body.id] }
      })
      assert.equal(linked.response.status, 201)
    }

    const linkedFirst = (await requestJson(`${url}/api/talent-pools/${first.id}`)).body
    const linkedSecond = (await requestJson(`${url}/api/talent-pools/${second.id}`)).body

    const duplicate = await requestJson(`${url}/api/talent-pools/archive-batch`, {
      method: 'POST',
      body: {
        records: [
          { id: linkedFirst.id, expected_updated_at: linkedFirst.updated_at },
          { id: linkedFirst.id, expected_updated_at: linkedFirst.updated_at }
        ]
      }
    })
    assert.equal(duplicate.response.status, 422)
    assert.equal(duplicate.body.error.code, 'validation_error')
    assert.equal(app.locals.db.prepare('SELECT archived_at FROM talent_pools WHERE id = ?').get(first.id).archived_at, null)

    const archived = await requestJson(`${url}/api/talent-pools/archive-batch`, {
      method: 'POST',
      body: { records: records([linkedFirst, linkedSecond]) }
    })
    assert.equal(archived.response.status, 200)
    assert.equal(archived.body.updated_count, 2)
    assert.ok(archived.body.items.every((item) => item.archived_at))

    const single = await createPool(url, 'Anonymous Single Pool')
    const mixedRestore = await requestJson(`${url}/api/talent-pools/restore-batch`, {
      method: 'POST',
      body: {
        records: [
          { id: archived.body.items[0].id, expected_updated_at: archived.body.items[0].updated_at },
          { id: single.id, expected_updated_at: single.updated_at }
        ]
      }
    })
    assert.equal(mixedRestore.response.status, 409)
    assert.deepEqual(mixedRestore.body.error.details.not_archived_ids, [single.id])
    assert.ok(app.locals.db.prepare('SELECT archived_at FROM talent_pools WHERE id = ?').get(first.id).archived_at)

    app.locals.db.prepare('UPDATE talent_pools SET updated_at = ? WHERE id = ?')
      .run('2099-03-01T00:00:00.000Z', second.id)
    const staleRestore = await requestJson(`${url}/api/talent-pools/restore-batch`, {
      method: 'POST',
      body: { records: records(archived.body.items) }
    })
    assert.equal(staleRestore.response.status, 409)
    assert.deepEqual(staleRestore.body.error.details.version_conflict_ids, [second.id])
    assert.ok(app.locals.db.prepare('SELECT archived_at FROM talent_pools WHERE id = ?').get(first.id).archived_at)
    const refreshedSecond = (await requestJson(`${url}/api/talent-pools/${second.id}`)).body

    const restored = await requestJson(`${url}/api/talent-pools/restore-batch`, {
      method: 'POST',
      body: { records: records([archived.body.items[0], refreshedSecond]) }
    })
    assert.equal(restored.response.status, 200)
    assert.equal(restored.body.updated_count, 2)
    assert.ok(restored.body.items.every((item) => item.archived_at === null))

    const activeDelete = await requestJson(`${url}/api/talent-pools/${first.id}/permanent-delete`, {
      method: 'POST',
      body: { expected_updated_at: restored.body.items[0].updated_at }
    })
    assert.equal(activeDelete.response.status, 409)
    assert.equal(activeDelete.body.error.code, 'talent_pool_permanent_delete_conflict')
    assert.deepEqual(activeDelete.body.error.details.not_archived_ids, [first.id])

    const archivedAgain = await requestJson(`${url}/api/talent-pools/archive-batch`, {
      method: 'POST',
      body: { records: records(restored.body.items) }
    })
    assert.equal(archivedAgain.response.status, 200)
    const removed = await requestJson(`${url}/api/talent-pools/permanent-delete-batch`, {
      method: 'POST',
      body: { records: records(archivedAgain.body.items) }
    })
    assert.equal(removed.response.status, 200)
    assert.equal(removed.body.deleted_count, 2)
    assert.equal(removed.body.affected_candidate_count, 1)
    assert.equal(removed.body.relation_count, 2)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM talent_pools').get().count, 1)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidate_talent_pools').get().count, 0)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidates WHERE id = ?').get(candidate.body.id).count, 1)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM notes WHERE candidate_id = ?').get(candidate.body.id).count, 1)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM positions WHERE id = ?').get(position.id).count, 1)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidate_positions WHERE candidate_id = ? AND position_id = ?')
      .get(candidate.body.id, position.id).count, 1)
    assert.ok(app.locals.db.prepare('SELECT COUNT(*) AS count FROM activities WHERE candidate_id = ?').get(candidate.body.id).count > 0)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidate_profile_sections WHERE candidate_id = ?')
      .get(candidate.body.id).count, 1)
    assert.equal(app.locals.db.prepare("SELECT COUNT(*) AS count FROM candidate_resume_documents WHERE candidate_id = ? AND source_type = 'profile_section'")
      .get(candidate.body.id).count, 1)

    const legacyArchived = await requestJson(`${url}/api/talent-pools/${single.id}/archive`, {
      method: 'POST'
    })
    assert.equal(legacyArchived.response.status, 200)
    assert.ok(legacyArchived.body.archived_at)
    const repeatedLegacyArchive = await requestJson(`${url}/api/talent-pools/${single.id}/archive`, {
      method: 'POST'
    })
    assert.equal(repeatedLegacyArchive.response.status, 409)
    assert.equal(repeatedLegacyArchive.body.error.code, 'talent_pool_archive_conflict')
    const legacyRestored = await requestJson(`${url}/api/talent-pools/${single.id}/restore`, {
      method: 'POST'
    })
    assert.equal(legacyRestored.response.status, 200)
    assert.equal(legacyRestored.body.archived_at, null)
    const repeatedLegacyRestore = await requestJson(`${url}/api/talent-pools/${single.id}/restore`, {
      method: 'POST'
    })
    assert.equal(repeatedLegacyRestore.response.status, 409)
    assert.equal(repeatedLegacyRestore.body.error.code, 'talent_pool_restore_conflict')

    const singleArchived = await requestJson(`${url}/api/talent-pools/${single.id}/archive`, {
      method: 'POST',
      body: { expected_updated_at: legacyRestored.body.updated_at }
    })
    assert.equal(singleArchived.response.status, 200)
    const singleRestored = await requestJson(`${url}/api/talent-pools/${single.id}/restore`, {
      method: 'POST',
      body: { expected_updated_at: singleArchived.body.updated_at }
    })
    assert.equal(singleRestored.response.status, 200)
    const staleSingle = await requestJson(`${url}/api/talent-pools/${single.id}/archive`, {
      method: 'POST',
      body: { expected_updated_at: legacyRestored.body.updated_at }
    })
    assert.equal(staleSingle.response.status, 409)
    const singleArchivedAgain = await requestJson(`${url}/api/talent-pools/${single.id}/archive`, {
      method: 'POST',
      body: { expected_updated_at: singleRestored.body.updated_at }
    })
    assert.equal(singleArchivedAgain.response.status, 200)
    const singleDeleted = await requestJson(`${url}/api/talent-pools/${single.id}/permanent-delete`, {
      method: 'POST',
      body: { expected_updated_at: singleArchivedAgain.body.updated_at }
    })
    assert.equal(singleDeleted.response.status, 200)
    assert.equal(singleDeleted.body.talent_pool_id, single.id)

    const oversized = await requestJson(`${url}/api/talent-pools/archive-batch`, {
      method: 'POST',
      body: {
        records: Array.from({ length: 101 }, (_, index) => ({
          id: `anonymous-pool-${index}`,
          expected_updated_at: '2026-01-01T00:00:00.000Z'
        }))
      }
    })
    assert.equal(oversized.response.status, 413)
    assert.equal(oversized.body.error.code, 'limit_exceeded')

    for (const endpoint of ['restore-batch', 'permanent-delete-batch']) {
      const oversizedOperation = await requestJson(`${url}/api/talent-pools/${endpoint}`, {
        method: 'POST',
        body: {
          records: Array.from({ length: 101 }, (_, index) => ({
            id: `anonymous-pool-${endpoint}-${index}`,
            expected_updated_at: '2026-01-01T00:00:00.000Z'
          }))
        }
      })
      assert.equal(oversizedOperation.response.status, 413)
      assert.equal(oversizedOperation.body.error.code, 'limit_exceeded')
    }
  } finally {
    await isolated.close()
  }
})

test('talent pool conflicts and runtime failures roll back every pool and membership relation', async () => {
  const isolated = await startIsolatedApp()
  const { app, url } = isolated
  try {
    const activeOne = await createPool(url, 'Anonymous Conflict Pool One')
    const activeTwo = await createPool(url, 'Anonymous Conflict Pool Two')
    app.locals.db.prepare('UPDATE talent_pools SET updated_at = ? WHERE id = ?')
      .run('2099-02-01T00:00:00.000Z', activeTwo.id)
    const stale = await requestJson(`${url}/api/talent-pools/archive-batch`, {
      method: 'POST',
      body: { records: records([activeOne, activeTwo]) }
    })
    assert.equal(stale.response.status, 409)
    assert.deepEqual(stale.body.error.details.version_conflict_ids, [activeTwo.id])
    assert.equal(app.locals.db.prepare('SELECT archived_at FROM talent_pools WHERE id = ?').get(activeOne.id).archived_at, null)

    const activeTwoCurrent = (await requestJson(`${url}/api/talent-pools/${activeTwo.id}`)).body
    const archivedTwo = await requestJson(`${url}/api/talent-pools/${activeTwo.id}/archive`, {
      method: 'POST',
      body: { expected_updated_at: activeTwoCurrent.updated_at }
    })
    assert.equal(archivedTwo.response.status, 200)
    const mixed = await requestJson(`${url}/api/talent-pools/archive-batch`, {
      method: 'POST',
      body: {
        records: [
          { id: activeOne.id, expected_updated_at: activeOne.updated_at },
          { id: activeTwo.id, expected_updated_at: archivedTwo.body.updated_at }
        ]
      }
    })
    assert.equal(mixed.response.status, 409)
    assert.deepEqual(mixed.body.error.details.already_archived_ids, [activeTwo.id])
    assert.equal(app.locals.db.prepare('SELECT archived_at FROM talent_pools WHERE id = ?').get(activeOne.id).archived_at, null)

    const missing = await requestJson(`${url}/api/talent-pools/archive-batch`, {
      method: 'POST',
      body: {
        records: [
          { id: activeOne.id, expected_updated_at: activeOne.updated_at },
          { id: 'missing-anonymous-pool', expected_updated_at: activeOne.updated_at }
        ]
      }
    })
    assert.equal(missing.response.status, 409)
    assert.deepEqual(missing.body.error.details.missing_ids, ['missing-anonymous-pool'])
    assert.equal(app.locals.db.prepare('SELECT archived_at FROM talent_pools WHERE id = ?').get(activeOne.id).archived_at, null)

    const candidate = await requestJson(`${url}/api/candidates`, {
      method: 'POST',
      body: { name: 'Anonymous Rollback Candidate', email: 'rollback-pool@example.test' }
    })
    const rollbackOne = await createPool(url, 'Anonymous Runtime Rollback Pool One')
    const rollbackTwo = await createPool(url, 'Anonymous Runtime Rollback Pool Two')
    for (const pool of [rollbackOne, rollbackTwo]) {
      await requestJson(`${url}/api/talent-pools/${pool.id}/candidates`, {
        method: 'POST',
        body: { candidate_ids: [candidate.body.id] }
      })
    }
    const linkedRollbackOne = (await requestJson(`${url}/api/talent-pools/${rollbackOne.id}`)).body
    const linkedRollbackTwo = (await requestJson(`${url}/api/talent-pools/${rollbackTwo.id}`)).body

    app.locals.db.exec(`
      CREATE TRIGGER anonymous_pool_archive_abort
      BEFORE UPDATE OF archived_at ON talent_pools
      WHEN OLD.id = '${rollbackTwo.id}' AND NEW.archived_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'anonymous forced pool archive rollback');
      END;
    `)
    assert.throws(
      () => archiveTalentPools(app.locals.db, records([linkedRollbackOne, linkedRollbackTwo])),
      /anonymous forced pool archive rollback/
    )
    assert.equal(app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM talent_pools
      WHERE id IN (?, ?) AND archived_at IS NULL
    `).get(rollbackOne.id, rollbackTwo.id).count, 2)
    app.locals.db.exec('DROP TRIGGER anonymous_pool_archive_abort')

    const rollbackArchived = await requestJson(`${url}/api/talent-pools/archive-batch`, {
      method: 'POST',
      body: { records: records([linkedRollbackOne, linkedRollbackTwo]) }
    })
    assert.equal(rollbackArchived.response.status, 200)

    app.locals.db.exec(`
      CREATE TRIGGER anonymous_pool_restore_abort
      BEFORE UPDATE OF archived_at ON talent_pools
      WHEN OLD.id = '${rollbackTwo.id}' AND NEW.archived_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'anonymous forced pool restore rollback');
      END;
    `)
    assert.throws(
      () => restoreTalentPools(app.locals.db, records(rollbackArchived.body.items)),
      /anonymous forced pool restore rollback/
    )
    assert.equal(app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM talent_pools
      WHERE id IN (?, ?) AND archived_at IS NOT NULL
    `).get(rollbackOne.id, rollbackTwo.id).count, 2)
    app.locals.db.exec('DROP TRIGGER anonymous_pool_restore_abort')

    app.locals.db.prepare('UPDATE talent_pools SET updated_at = ? WHERE id = ?')
      .run('2099-04-01T00:00:00.000Z', rollbackTwo.id)
    const staleDelete = await requestJson(`${url}/api/talent-pools/permanent-delete-batch`, {
      method: 'POST',
      body: { records: records(rollbackArchived.body.items) }
    })
    assert.equal(staleDelete.response.status, 409)
    assert.deepEqual(staleDelete.body.error.details.version_conflict_ids, [rollbackTwo.id])
    assert.equal(app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM talent_pools WHERE id IN (?, ?)
    `).get(rollbackOne.id, rollbackTwo.id).count, 2)
    assert.equal(app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM candidate_talent_pools WHERE talent_pool_id IN (?, ?)
    `).get(rollbackOne.id, rollbackTwo.id).count, 2)

    const refreshedRollbackOne = (await requestJson(`${url}/api/talent-pools/${rollbackOne.id}`)).body
    const refreshedRollbackTwo = (await requestJson(`${url}/api/talent-pools/${rollbackTwo.id}`)).body

    app.locals.db.exec(`
      CREATE TRIGGER anonymous_pool_delete_abort
      BEFORE DELETE ON talent_pools
      WHEN OLD.id = '${rollbackTwo.id}'
      BEGIN
        SELECT RAISE(ABORT, 'anonymous forced pool rollback');
      END;
    `)
    assert.throws(
      () => permanentlyDeleteTalentPools(app.locals.db, records([refreshedRollbackOne, refreshedRollbackTwo])),
      /anonymous forced pool rollback/
    )
    assert.equal(app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM talent_pools WHERE id IN (?, ?)
    `).get(rollbackOne.id, rollbackTwo.id).count, 2)
    assert.equal(app.locals.db.prepare(`
      SELECT COUNT(*) AS count FROM candidate_talent_pools WHERE talent_pool_id IN (?, ?)
    `).get(rollbackOne.id, rollbackTwo.id).count, 2)
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidates WHERE id = ?').get(candidate.body.id).count, 1)
  } finally {
    await isolated.close()
  }
})
