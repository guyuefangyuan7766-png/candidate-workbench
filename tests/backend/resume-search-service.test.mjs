import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { insertCandidate } from '../../server/candidates.js'
import { openDatabase } from '../../server/database.js'
import { ResumeSearchService, ResumeSearchServiceError } from '../../server/resume-search-service.js'

test('resume search worker is non-blocking, cursor-stable, cancellable and fails closed on an inconsistent resume index', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-resume-search-'))
  const databasePath = join(directory, 'anonymous.db')
  let db
  let service
  try {
    db = openDatabase(databasePath)
    const candidates = []
    for (let index = 0; index < 7; index += 1) {
      candidates.push(insertCandidate(db, {
        name: `Anonymous cursor candidate ${index}`,
        current_title: 'ResumeWorkerMarkerV10'
      }))
    }
    db.close()
    db = null

    service = new ResumeSearchService({ databasePath, workerTimeoutMs: 10_000 })
    const status = await service.status()
    assert.equal(status.ready, true)
    assert.equal(status.progress, 1)
    assert.equal(status.remaining, 0)
    assert.equal(status.search_index, 'candidate_resume_fts')

    const first = await service.search({ q: 'ResumeWorkerMarkerV10', page_size: 3 })
    assert.equal(first.items.length, 3)
    assert.equal(first.pagination.page, 1)
    assert.equal(first.pagination.total, null)
    assert.equal(first.pagination.has_more, true)
    assert.ok(first.pagination.next_cursor)
    assert.equal(first.index.ready, true)
    assert.ok(first.performance.worker_duration_ms >= 0)

    const second = await service.search({
      q: 'ResumeWorkerMarkerV10',
      page_size: 3,
      cursor: first.pagination.next_cursor
    })
    assert.equal(second.items.length, 3)
    assert.equal(second.pagination.page, 2)
    assert.equal(new Set([...first.items, ...second.items].map((item) => item.candidate_id)).size, 6)

    await assert.rejects(
      service.search({
        q: 'different query',
        page_size: 3,
        cursor: first.pagination.next_cursor
      }),
      (error) => error instanceof ResumeSearchServiceError && error.code === 'invalid_cursor' && error.status === 400
    )

    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      service.search({ q: 'ResumeWorkerMarkerV10' }, { signal: controller.signal }),
      (error) => error instanceof ResumeSearchServiceError && error.code === 'search_cancelled'
    )

    db = openDatabase(databasePath, { synchronizeSearch: false })
    db.prepare('UPDATE candidates SET current_title = ?, updated_at = ? WHERE id = ?')
      .run('ResumeWorkerMarkerV10Updated', new Date().toISOString(), candidates[0].id)
    db.close()
    db = null

    const incrementallyUpdated = await service.status()
    assert.equal(incrementallyUpdated.ready, true)
    const updated = await service.search({ q: 'ResumeWorkerMarkerV10Updated' })
    assert.deepEqual(updated.items.map((item) => item.candidate_id), [candidates[0].id])

    db = openDatabase(databasePath, { synchronizeSearch: false })
    const rowId = db.prepare(`
      SELECT row_id FROM candidate_resume_documents WHERE document_id = ?
    `).get(`candidate:${candidates[0].id}`).row_id
    db.prepare('DELETE FROM candidate_resume_fts WHERE rowid = ?').run(rowId)
    db.close()
    db = null

    const pending = await service.status()
    assert.equal(pending.ready, false)
    assert.equal(pending.remaining, 1)
    assert.ok(pending.progress < 1)
    await assert.rejects(
      service.search({ q: 'ResumeWorkerMarkerV10' }),
      (error) => error instanceof ResumeSearchServiceError
        && error.code === 'search_index_not_ready'
        && error.status === 503
        && error.details?.remaining === 1
    )
  } finally {
    try { db?.close() } catch {}
    try { await service?.close() } catch {}
    rmSync(directory, { recursive: true, force: true })
  }
})
