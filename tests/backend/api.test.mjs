import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { afterEach, test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { createApp } from '../../server/app.js'
import { insertCandidate } from '../../server/candidates.js'
import { openDatabase } from '../../server/database.js'

const cleanups = []

afterEach(async () => {
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
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`
  }
}

async function startApp(options = {}) {
  const app = createApp({ databasePath: ':memory:', ...options })
  cleanups.push(async () => app.closeDatabase())
  const running = await listen(app)
  return { app, ...running }
}

async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers)
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const response = await fetch(url, {
    ...options,
    headers,
    body: options.body && !(options.body instanceof FormData) && typeof options.body !== 'string'
      ? JSON.stringify(options.body)
      : options.body
  })
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}

async function waitForAgentTerminal(url, submission, timeoutMs = 10_000) {
  if (submission.response.status !== 202) return submission
  const taskId = submission.body?.task_id ?? submission.body?.task?.task_id
  assert.ok(taskId)
  const deadline = Date.now() + timeoutMs
  let latest = submission
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    latest = await requestJson(`${url}/api/agent/tasks/${taskId}`)
    const state = latest.body?.state ?? latest.body?.task?.status
    if (['completed', 'partial', 'failed', 'cancelled'].includes(state)) return latest
  }
  throw new Error(`Agent task did not finish: ${latest.body?.state ?? latest.body?.task?.status ?? 'unknown'}`)
}

async function previewImportWorkbook(url, headers, rows, filename) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('候选人增量')
  sheet.addRow(headers)
  for (const row of rows) sheet.addRow(row)
  const form = new FormData()
  form.append(
    'file',
    new Blob([Buffer.from(await workbook.xlsx.writeBuffer())], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }),
    filename
  )
  return requestJson(`${url}/api/import/preview`, { method: 'POST', body: form })
}

test('position tables are added incrementally without changing legacy candidate data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-positions-'))
  const databasePath = join(directory, 'legacy.db')
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }))

  let db = openDatabase(databasePath)
  const legacyCandidate = insertCandidate(db, {
    name: 'Legacy Candidate',
    email: 'legacy@example.com',
    stage: '筛选中'
  })
  db.exec('DROP TABLE candidate_positions; DROP TABLE positions;')
  db.close()

  db = openDatabase(databasePath)
  try {
    const preserved = db.prepare('SELECT id, name, email, stage FROM candidates WHERE id = ?').get(legacyCandidate.id)
    assert.deepEqual({ ...preserved }, {
      id: legacyCandidate.id,
      name: 'Legacy Candidate',
      email: 'legacy@example.com',
      stage: '筛选中'
    })
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'positions'").get().count, 1)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'candidate_positions'").get().count, 1)

    const relationColumns = db.prepare('PRAGMA table_info(candidate_positions)').all()
    assert.equal(relationColumns.find((column) => column.name === 'candidate_id').pk, 1)
    assert.equal(relationColumns.find((column) => column.name === 'position_id').pk, 2)
    assert.equal(db.prepare('PRAGMA foreign_key_list(candidate_positions)').all().length, 2)
  } finally {
    db.close()
  }
})

test('position CRUD, filtering, candidate links, conflicts, activity history, and export', async () => {
  const { url } = await startApp()
  const createCandidate = async (name, email) => {
    const result = await requestJson(`${url}/api/candidates`, {
      method: 'POST',
      body: { name, email }
    })
    assert.equal(result.response.status, 201)
    return result.body
  }

  const candidateA = await createCandidate('Position Candidate A', 'position-a@example.com')
  const candidateB = await createCandidate('Position Candidate B', 'position-b@example.com')
  const candidateC = await createCandidate('Unassigned Candidate C', 'position-c@example.com')

  const invalidPosition = await requestJson(`${url}/api/positions`, {
    method: 'POST',
    body: { title: '', headcount: 0, status: 'unknown' }
  })
  assert.equal(invalidPosition.response.status, 422)
  assert.equal(invalidPosition.body.error.code, 'validation_error')
  assert.deepEqual(
    invalidPosition.body.error.details.map((error) => error.field).sort(),
    ['headcount', 'status', 'title']
  )
  const unknownField = await requestJson(`${url}/api/positions`, {
    method: 'POST',
    body: { title: 'Invalid Position', candidate_count: 99 }
  })
  assert.equal(unknownField.response.status, 422)
  assert.equal(unknownField.body.error.details[0].field, 'candidate_count')
  const invalidQuery = await requestJson(`${url}/api/positions?page_size=101&sort=unsupported`)
  assert.equal(invalidQuery.response.status, 400)

  const backend = await requestJson(`${url}/api/positions`, {
    method: 'POST',
    body: {
      title: 'Senior Backend Engineer',
      department: 'Engineering',
      location: 'Shanghai',
      owner: 'Recruiter A',
      headcount: 2,
      status: 'open',
      description: 'Build the candidate platform.',
      tags: ['Backend', 'Platform', 'Backend']
    }
  })
  assert.equal(backend.response.status, 201)
  assert.equal(backend.body.candidate_count, 0)
  assert.deepEqual(backend.body.tags, ['Backend', 'Platform'])

  const product = await requestJson(`${url}/api/positions`, {
    method: 'POST',
    body: {
      title: 'Product Manager',
      department: 'Product',
      location: 'Beijing',
      owner: 'Recruiter B',
      headcount: 1,
      status: 'paused'
    }
  })
  assert.equal(product.response.status, 201)

  const openPositions = await requestJson(
    `${url}/api/positions?status=open&department=Engineering&page=1&page_size=1&sort=title&order=asc`
  )
  assert.equal(openPositions.response.status, 200)
  assert.equal(openPositions.body.pagination.total, 1)
  assert.equal(openPositions.body.items[0].id, backend.body.id)

  const searched = await requestJson(`${url}/api/positions?search=backend`)
  assert.equal(searched.body.pagination.total, 1)

  const patched = await requestJson(`${url}/api/positions/${backend.body.id}`, {
    method: 'PATCH',
    body: { title: 'Principal Backend Engineer', headcount: 3, tags: 'Core, Platform' }
  })
  assert.equal(patched.response.status, 200)
  assert.equal(patched.body.title, 'Principal Backend Engineer')
  assert.equal(patched.body.headcount, 3)
  assert.deepEqual(patched.body.tags, ['Core', 'Platform'])

  const firstLink = await requestJson(`${url}/api/positions/${backend.body.id}/candidates`, {
    method: 'POST',
    body: { candidate_ids: [candidateA.id, candidateB.id, candidateA.id] }
  })
  assert.equal(firstLink.response.status, 201)
  assert.equal(firstLink.body.input_count, 3)
  assert.equal(firstLink.body.requested_count, 2)
  assert.equal(firstLink.body.duplicate_input_count, 1)
  assert.equal(firstLink.body.linked_count, 2)
  assert.equal(firstLink.body.existing_count, 0)
  assert.equal(firstLink.body.position.candidate_count, 2)

  const replayLink = await requestJson(`${url}/api/positions/${backend.body.id}/candidates`, {
    method: 'POST',
    body: { candidate_ids: [candidateA.id, candidateB.id] }
  })
  assert.equal(replayLink.response.status, 200)
  assert.equal(replayLink.body.linked_count, 0)
  assert.equal(replayLink.body.existing_count, 2)

  const candidateDetail = await requestJson(`${url}/api/candidates/${candidateA.id}`)
  assert.equal(candidateDetail.body.positions.length, 1)
  assert.equal(candidateDetail.body.positions[0].id, backend.body.id)
  assert.equal(candidateDetail.body.positions[0].candidate_count, 2)
  assert.equal(Object.hasOwn(candidateDetail.body, 'stage'), false, 'legacy stage is hidden by default')
  const legacyDetail = await requestJson(`${url}/api/candidates/${candidateA.id}?include_legacy_stage=true`)
  assert.equal(legacyDetail.body.stage, '新候选人', 'position links must not change the stored legacy stage')

  const candidatePositions = await requestJson(`${url}/api/candidates/${candidateA.id}/positions`)
  assert.equal(candidatePositions.body.items.length, 1)
  assert.equal(candidatePositions.body.items[0].candidate_count, 2)

  const positionCandidates = await requestJson(`${url}/api/positions/${backend.body.id}/candidates?page_size=1`)
  assert.equal(positionCandidates.body.pagination.total, 2)
  assert.equal(positionCandidates.body.items.length, 1)
  assert.equal(positionCandidates.body.items[0].positions[0].id, backend.body.id)
  assert.equal(positionCandidates.body.items[0].positions[0].candidate_count, 2)

  const filteredCandidates = await requestJson(`${url}/api/candidates?position_id=${backend.body.id}`)
  assert.equal(filteredCandidates.body.pagination.total, 2)
  assert.ok(filteredCandidates.body.items.every((candidate) => candidate.positions.some((position) => position.id === backend.body.id)))
  const unassignedCandidates = await requestJson(`${url}/api/candidates?position_id=unassigned`)
  assert.equal(unassignedCandidates.body.pagination.total, 1)
  assert.equal(unassignedCandidates.body.items[0].id, candidateC.id)

  const filteredExport = await fetch(`${url}/api/export?format=csv&position_id=${backend.body.id}`)
  assert.equal(filteredExport.status, 200)
  const filteredCsv = Buffer.from(await filteredExport.arrayBuffer()).toString('utf8')
  assert.match(filteredCsv, /Position Candidate A/)
  assert.match(filteredCsv, /Position Candidate B/)
  assert.doesNotMatch(filteredCsv, /Unassigned Candidate C/)

  const atomicConflict = await requestJson(`${url}/api/positions/${product.body.id}/candidates`, {
    method: 'POST',
    body: { candidate_ids: [candidateC.id, 'missing-candidate-id'] }
  })
  assert.equal(atomicConflict.response.status, 404)
  assert.equal(atomicConflict.body.error.code, 'not_found')
  const productAfterConflict = await requestJson(`${url}/api/positions/${product.body.id}`)
  assert.equal(productAfterConflict.body.candidate_count, 0, 'a failed batch must not partially link candidates')

  await requestJson(`${url}/api/candidates/${candidateC.id}/archive`, { method: 'POST' })
  const archivedCandidateConflict = await requestJson(`${url}/api/positions/${product.body.id}/candidates`, {
    method: 'POST',
    body: { candidate_ids: [candidateC.id] }
  })
  assert.equal(archivedCandidateConflict.response.status, 409)
  assert.equal(archivedCandidateConflict.body.error.code, 'conflict')
  await requestJson(`${url}/api/candidates/${candidateC.id}/restore`, { method: 'POST' })

  const pausedLink = await requestJson(`${url}/api/positions/${product.body.id}/candidates`, {
    method: 'POST',
    body: { candidate_ids: [candidateC.id] }
  })
  assert.equal(pausedLink.response.status, 201, 'paused positions still allow candidate organization')
  const pausedUnlink = await requestJson(`${url}/api/positions/${product.body.id}/candidates/${candidateC.id}`, {
    method: 'DELETE'
  })
  assert.equal(pausedUnlink.body.removed, true)

  await requestJson(`${url}/api/positions/${product.body.id}`, {
    method: 'PATCH',
    body: { status: 'closed' }
  })
  const closedPositionConflict = await requestJson(`${url}/api/positions/${product.body.id}/candidates`, {
    method: 'POST',
    body: { candidate_ids: [candidateC.id] }
  })
  assert.equal(closedPositionConflict.response.status, 409)
  assert.equal(closedPositionConflict.body.error.code, 'conflict')
  await requestJson(`${url}/api/positions/${product.body.id}`, {
    method: 'PATCH',
    body: { status: 'paused' }
  })

  const batchUnlinked = await requestJson(`${url}/api/positions/${backend.body.id}/candidates`, {
    method: 'DELETE',
    body: { candidate_ids: [candidateA.id, candidateA.id, candidateC.id] }
  })
  assert.equal(batchUnlinked.response.status, 200)
  assert.deepEqual(batchUnlinked.body, {
    position_id: backend.body.id,
    input_count: 3,
    requested_count: 2,
    duplicate_input_count: 1,
    removed_count: 1,
    existing_count: 1,
    absent_count: 1
  })
  const replayBatchUnlink = await requestJson(`${url}/api/positions/${backend.body.id}/candidates`, {
    method: 'DELETE',
    body: { candidate_ids: [candidateA.id, candidateC.id] }
  })
  assert.equal(replayBatchUnlink.body.removed_count, 0)
  assert.equal(replayBatchUnlink.body.absent_count, 2)

  const failedBatchUnlink = await requestJson(`${url}/api/positions/${backend.body.id}/candidates`, {
    method: 'DELETE',
    body: { candidate_ids: [candidateB.id, 'missing-candidate-id'] }
  })
  assert.equal(failedBatchUnlink.response.status, 404)
  assert.equal(failedBatchUnlink.body.error.code, 'not_found')
  const afterFailedBatchUnlink = await requestJson(`${url}/api/positions/${backend.body.id}`)
  assert.equal(afterFailedBatchUnlink.body.candidate_count, 1, 'failed batch unlink must preserve every requested link')

  const replayUnlink = await requestJson(`${url}/api/positions/${backend.body.id}/candidates/${candidateA.id}`, {
    method: 'DELETE'
  })
  assert.equal(replayUnlink.body.removed, false)

  const activities = await requestJson(`${url}/api/candidates/${candidateA.id}/activities`)
  assert.equal(activities.body.data.filter((activity) => activity.type === 'position_linked').length, 1)
  assert.equal(activities.body.data.filter((activity) => activity.type === 'position_unlinked').length, 1)
  assert.equal(activities.body.data.find((activity) => activity.type === 'position_linked').metadata.position_id, backend.body.id)

  const archivedPosition = await requestJson(`${url}/api/positions/${backend.body.id}/archive`, { method: 'POST' })
  assert.ok(archivedPosition.body.archived_at)
  const archivedPositionConflict = await requestJson(`${url}/api/positions/${backend.body.id}/candidates`, {
    method: 'POST',
    body: { candidate_ids: [candidateC.id] }
  })
  assert.equal(archivedPositionConflict.response.status, 409)
  assert.equal(archivedPositionConflict.body.error.code, 'conflict')

  const defaultPositions = await requestJson(`${url}/api/positions`)
  assert.equal(defaultPositions.body.pagination.total, 1)
  assert.equal(defaultPositions.body.items[0].id, product.body.id)
  const archiveOnly = await requestJson(`${url}/api/positions?archived=only`)
  assert.equal(archiveOnly.body.pagination.total, 1)
  assert.equal(archiveOnly.body.items[0].id, backend.body.id)

  const dashboard = await requestJson(`${url}/api/dashboard`)
  assert.deepEqual(dashboard.body.position_totals, { total: 2, active: 1, archived: 1, open: 0 })
  assert.equal(dashboard.body.unassigned_candidates, 2)
  assert.equal(Number.isInteger(dashboard.body.recent_update_count), true)
  assert.ok(dashboard.body.recent_update_count >= 0)
  assert.ok(Array.isArray(dashboard.body.positions_by_status))
  assert.ok(Array.isArray(dashboard.body.recent_positions))

  const restoredPosition = await requestJson(`${url}/api/positions/${backend.body.id}/restore`, { method: 'POST' })
  assert.equal(restoredPosition.body.archived_at, null)
})

test('candidate query parameters reject repeated, invalid, and oversized values with safe 4xx errors', async () => {
  const { url } = await startApp()
  const invalidQueries = [
    'stage=one&stage=two',
    'page=1000001',
    'page=1suffix',
    'page_size=101',
    'archived=unexpected',
    'sort=unsupported',
    'order=sideways',
    `search=${encodeURIComponent('s'.repeat(301))}`,
    `tag=${encodeURIComponent('t'.repeat(81))}`,
    `position_id=${encodeURIComponent('p'.repeat(201))}`
  ]

  for (const query of invalidQueries) {
    const result = await requestJson(`${url}/api/candidates?${query}`)
    assert.equal(result.response.status, 400, query)
    assert.equal(result.body.error.code, 'invalid_query', query)
    assert.equal(Array.isArray(result.body.error.details), true, query)
    assert.doesNotMatch(JSON.stringify(result.body), /SQLITE|ERR_INVALID|named parameter/i, query)
  }

  const repeatedExportFormat = await requestJson(`${url}/api/export?format=csv&format=xlsx`)
  assert.equal(repeatedExportFormat.response.status, 400)
  assert.equal(repeatedExportFormat.body.error.code, 'invalid_query')
  assert.doesNotMatch(JSON.stringify(repeatedExportFormat.body), /SQLITE|ERR_INVALID|named parameter/i)

  const oversizedExportPage = await requestJson(`${url}/api/export?format=csv&page=1000001`)
  assert.equal(oversizedExportPage.response.status, 400)
  assert.equal(oversizedExportPage.body.error.code, 'invalid_query')

  const ignoredUnknownParameter = await requestJson(`${url}/api/candidates?legacy_client_hint=keep-compatible`)
  assert.equal(ignoredUnknownParameter.response.status, 200)
})

test('candidate search, exact tags, and exports use the same candidate set', async () => {
  const { url } = await startApp()
  const createCandidate = async (body) => {
    const result = await requestJson(`${url}/api/candidates`, { method: 'POST', body })
    assert.equal(result.response.status, 201)
    return result.body
  }

  const alpha = await createCandidate({
    name: 'Filter Alpha',
    phone: '13800138011',
    email: 'filter.alpha@example.com',
    current_company: 'Northstar Systems',
    current_title: 'Data Steward',
    location: 'Shanghai',
    source: 'Employee Referral',
    owner: 'Recruiter Search',
    tags: ['Go', 'Core']
  })
  const beta = await createCandidate({
    name: 'Filter Beta',
    phone: '13800138012',
    email: 'filter.beta@example.com',
    current_company: 'Southstar Systems',
    current_title: 'Service Engineer',
    location: 'Beijing',
    source: 'Direct',
    owner: 'Recruiter Other',
    tags: ['Golang']
  })
  const literalWildcard = await createCandidate({
    name: 'Literal % Candidate',
    email: 'literal-percent@example.com',
    tags: ['Other']
  })
  const position = await requestJson(`${url}/api/positions`, {
    method: 'POST',
    body: { title: 'Distributed Platform Lead', status: 'open', headcount: 1 }
  })
  assert.equal(position.response.status, 201)
  const linked = await requestJson(`${url}/api/positions/${position.body.id}/candidates`, {
    method: 'POST',
    body: { candidate_ids: [alpha.id] }
  })
  assert.equal(linked.response.status, 201)

  const searchTerms = [
    'Filter Alpha',
    'Northstar Systems',
    'Data Steward',
    'Shanghai',
    'Employee Referral',
    'Recruiter Search',
    'Core',
    'Distributed Platform Lead'
  ]
  for (const term of searchTerms) {
    const result = await requestJson(`${url}/api/candidates?search=${encodeURIComponent(term)}`)
    assert.equal(result.response.status, 200, term)
    assert.equal(result.body.pagination.total, 1, term)
    assert.equal(result.body.items[0].id, alpha.id, term)
  }

  for (const sensitiveTerm of ['13800138011', 'filter.alpha@example.com']) {
    const result = await requestJson(`${url}/api/candidates?search=${encodeURIComponent(sensitiveTerm)}`)
    assert.equal(result.body.pagination.total, 0, 'sensitive contact data must not be searchable')
  }

  const exactTag = await requestJson(`${url}/api/candidates?tag=Go`)
  assert.equal(exactTag.body.pagination.total, 1)
  assert.equal(exactTag.body.items[0].id, alpha.id)
  assert.notEqual(exactTag.body.items[0].id, beta.id)

  const escapedWildcard = await requestJson(`${url}/api/candidates?search=${encodeURIComponent('%')}`)
  assert.equal(escapedWildcard.body.pagination.total, 1)
  assert.equal(escapedWildcard.body.items[0].id, literalWildcard.id)

  const tagExport = await fetch(`${url}/api/export?format=csv&tag=Go`)
  assert.equal(tagExport.status, 200)
  const tagCsv = Buffer.from(await tagExport.arrayBuffer()).toString('utf8')
  assert.match(tagCsv, /Filter Alpha/)
  assert.doesNotMatch(tagCsv, /Filter Beta/)

  for (const search of ['Employee Referral', 'Distributed Platform Lead']) {
    const exported = await fetch(`${url}/api/candidates/export?format=csv&search=${encodeURIComponent(search)}`)
    assert.equal(exported.status, 200, search)
    const csv = Buffer.from(await exported.arrayBuffer()).toString('utf8')
    assert.match(csv, /Filter Alpha/, search)
    assert.doesNotMatch(csv, /Filter Beta|Literal % Candidate/, search)
  }
})

test('candidate pagination and export use id as a stable secondary sort key', async () => {
  const { app, url } = await startApp()
  const timestamp = '2026-08-04T00:00:00.000Z'
  for (const id of ['tie-c', 'tie-a', 'tie-b']) {
    insertCandidate(app.locals.db, {
      id,
      name: 'Same Sort Value',
      stage: '新候选人',
      created_at: timestamp,
      updated_at: timestamp
    })
  }

  const firstPage = await requestJson(`${url}/api/candidates?sort=updated_at&order=desc&page=1&page_size=2`)
  const secondPage = await requestJson(`${url}/api/candidates?sort=updated_at&order=desc&page=2&page_size=2`)
  assert.deepEqual(
    [...firstPage.body.items, ...secondPage.body.items].map((candidate) => candidate.id),
    ['tie-a', 'tie-b', 'tie-c']
  )

  const exported = await fetch(`${url}/api/export?format=csv&sort=updated_at&order=desc`)
  assert.equal(exported.status, 200)
  const csv = Buffer.from(await exported.arrayBuffer()).toString('utf8')
  assert.ok(csv.indexOf('tie-a') < csv.indexOf('tie-b'))
  assert.ok(csv.indexOf('tie-b') < csv.indexOf('tie-c'))
})

test('candidate lifecycle, notes, activities, dashboard, and non-name deduplication', async () => {
  const { url } = await startApp()

  const health = await requestJson(`${url}/api/health`)
  assert.equal(health.response.status, 200)
  assert.equal(health.body.status, 'ok')

  const created = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: {
      name: 'Alice Zhang',
      phone: '138 0013 8000',
      email: 'Alice@Example.COM',
      current_company: 'Example Co',
      stage: '初筛',
      tags: ['后端', 'Go']
    }
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.phone, '+8613800138000')
  assert.equal(created.body.email, 'alice@example.com')
  assert.equal(created.body.stage, '筛选中')

  const sameName = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'Alice Zhang', current_company: 'Another Co' }
  })
  assert.equal(sameName.response.status, 201, 'name alone must never trigger deduplication')

  const duplicateEmail = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'Different Name', email: 'alice@example.com' }
  })
  assert.equal(duplicateEmail.response.status, 409)
  assert.equal(duplicateEmail.body.error.details.matched_by, 'email')

  const updated = await requestJson(`${url}/api/candidates/${created.body.id}`, {
    method: 'PATCH',
    body: { stage: 'interview', current_title: 'Staff Engineer' }
  })
  assert.equal(updated.response.status, 200)
  assert.equal(updated.body.stage, '面试中')

  const note = await requestJson(`${url}/api/candidates/${created.body.id}/notes`, {
    method: 'POST',
    body: { content: '通过电话初步沟通。' }
  })
  assert.equal(note.response.status, 201)

  const detail = await requestJson(`${url}/api/candidates/${created.body.id}`)
  assert.equal(detail.body.notes.length, 1)
  assert.ok(detail.body.activities.some((activity) => activity.type === 'note_added'))
  assert.ok(detail.body.activities.some((activity) => activity.type === 'candidate_updated'))

  const archived = await requestJson(`${url}/api/candidates/${created.body.id}/archive`, { method: 'POST' })
  assert.ok(archived.body.archived_at)
  const activeList = await requestJson(`${url}/api/candidates?archived=exclude`)
  assert.equal(activeList.body.pagination.total, 1)
  const archiveList = await requestJson(`${url}/api/candidates?archived=only`)
  assert.equal(archiveList.body.pagination.total, 1)

  const restored = await requestJson(`${url}/api/candidates/${created.body.id}/restore`, { method: 'POST' })
  assert.equal(restored.body.archived_at, null)
  const summary = await requestJson(`${url}/api/dashboard`)
  assert.deepEqual(summary.body.totals, { total: 2, active: 2, archived: 0 })
})

test('CSV preview and commit maps Chinese headers, normalizes identities, and exports CSV/XLSX', async () => {
  const { url } = await startApp()
  const csv = [
    '姓名,手机号码,电子邮箱,当前公司,招聘阶段,标签,来源记录ID',
    '张三,13900139000,ZHANG@example.com,示例科技,初筛,"Go,后端",B-1',
    '张三,,,另一家公司,面试,Java,',
    '李四,13900139000,li@example.com,重复公司,面试,测试,B-3'
  ].join('\n')
  const form = new FormData()
  form.append('file', new Blob([Buffer.from(csv)], { type: 'text/csv' }), 'candidates.csv')
  form.append('source_system', 'beisen')

  const preview = await requestJson(`${url}/api/import/preview`, { method: 'POST', body: form })
  assert.equal(preview.response.status, 200)
  assert.equal(preview.body.mapping.name, '姓名')
  assert.equal(preview.body.mapping.phone, '手机号码')
  assert.equal(preview.body.summary.total_rows, 3)
  assert.equal(preview.body.summary.file_duplicates, 1)
  assert.equal(preview.body.rows[0].candidate.phone, '+8613900139000')
  assert.equal(preview.body.rows[0].candidate.source_system, 'beisen')

  const committed = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: preview.body.preview_token, on_duplicate: 'skip' }
  })
  assert.equal(committed.response.status, 201)
  assert.equal(committed.body.imported_rows, 2)
  assert.equal(committed.body.skipped_rows, 1)
  assert.match(committed.body.import_batch_id, /^[0-9a-f-]{36}$/)

  const replay = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: preview.body.preview_token }
  })
  assert.equal(replay.response.status, 404, 'preview tokens are one-time use')

  const list = await requestJson(`${url}/api/candidates`)
  assert.equal(list.body.pagination.total, 2, 'same-name row without identifiers must still import')

  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('候选人')
  sheet.addRow(['姓名', '手机号', '招聘阶段', '来源记录ID'])
  sheet.addRow(['王五', '13700137000', '面试', 'B-4'])
  const xlsxForm = new FormData()
  xlsxForm.append(
    'file',
    new Blob([Buffer.from(await workbook.xlsx.writeBuffer())], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }),
    'candidates.xlsx'
  )
  xlsxForm.append('source_system', 'beisen')
  const xlsxPreview = await requestJson(`${url}/api/import/preview`, { method: 'POST', body: xlsxForm })
  assert.equal(xlsxPreview.response.status, 200)
  assert.equal(xlsxPreview.body.summary.total_rows, 1)
  assert.equal(xlsxPreview.body.rows[0].candidate.stage, '新候选人', 'legacy stage is not auto-mapped')
  const xlsxCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: xlsxPreview.body.preview_token }
  })
  assert.equal(xlsxCommit.body.imported_rows, 1)

  const csvExport = await fetch(`${url}/api/export?format=csv`)
  assert.equal(csvExport.status, 200)
  const csvBuffer = Buffer.from(await csvExport.arrayBuffer())
  assert.deepEqual([...csvBuffer.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.match(csvBuffer.toString('utf8'), /候选人ID/)

  const xlsxExport = await fetch(`${url}/api/candidates/export?format=xlsx`)
  assert.equal(xlsxExport.status, 200)
  const xlsxBuffer = Buffer.from(await xlsxExport.arrayBuffer())
  assert.equal(xlsxBuffer.subarray(0, 2).toString(), 'PK')
})

test('work years persist through CRUD, generic imports, and export', async () => {
  const { url } = await startApp()
  const created = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'Work Years CRUD', years_experience: '3年6个月' }
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.years_experience_raw, '3年6个月')
  assert.equal(created.body.years_experience, 3.5)
  assert.equal(created.body.years_experience_display, '3年6个月')

  const unparseable = await requestJson(`${url}/api/candidates/${created.body.id}`, {
    method: 'PATCH',
    body: { years_experience: '经验不详' }
  })
  assert.equal(unparseable.response.status, 200)
  assert.equal(unparseable.body.years_experience_raw, '经验不详')
  assert.equal(unparseable.body.years_experience, null)
  assert.equal(unparseable.body.years_experience_display, '经验不详')

  const firstImport = new FormData()
  firstImport.append('file', new Blob([
    'name,source system,source record id,years experience\nGeneric Work Years,generic_import,generic-work-years-1,3年6个月\n'
  ], { type: 'text/csv' }), 'generic-work-years-first.csv')
  const firstPreview = await requestJson(`${url}/api/import/preview`, { method: 'POST', body: firstImport })
  assert.equal(firstPreview.response.status, 200)
  assert.equal(firstPreview.body.rows[0].candidate.years_experience_raw, '3年6个月')
  assert.equal(firstPreview.body.rows[0].candidate.years_experience, 3.5)
  assert.equal(firstPreview.body.rows[0].candidate.years_experience_display, '3年6个月')
  assert.equal(firstPreview.body.rows[0].errors.some((error) => error.field === 'years_experience'), false)
  const firstCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: firstPreview.body.preview_token }
  })
  assert.equal(firstCommit.body.imported_rows, 1)

  const updateImport = new FormData()
  updateImport.append('file', new Blob([
    'name,source system,source record id,years experience\nGeneric Work Years,generic_import,generic-work-years-1,经验不详\n'
  ], { type: 'text/csv' }), 'generic-work-years-update.csv')
  const updatePreview = await requestJson(`${url}/api/import/preview`, { method: 'POST', body: updateImport })
  assert.equal(updatePreview.response.status, 200)
  assert.equal(updatePreview.body.rows[0].candidate.years_experience_raw, '经验不详')
  assert.equal(updatePreview.body.rows[0].candidate.years_experience, null)
  assert.equal(updatePreview.body.rows[0].candidate.years_experience_display, '经验不详')
  assert.equal(updatePreview.body.rows[0].errors.some((error) => error.field === 'years_experience'), false)
  const updateCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: updatePreview.body.preview_token, on_duplicate: 'update' }
  })
  assert.equal(updateCommit.body.updated_rows, 1)

  const imported = await requestJson(`${url}/api/candidates?search=${encodeURIComponent('Generic Work Years')}`)
  const importedDetail = await requestJson(`${url}/api/candidates/${imported.body.items[0].id}`)
  assert.equal(importedDetail.body.years_experience_raw, '经验不详')
  assert.equal(importedDetail.body.years_experience, null)
  assert.equal(importedDetail.body.years_experience_display, '经验不详')

  const exported = await (await fetch(`${url}/api/candidates/export?format=csv&search=${encodeURIComponent('Generic Work Years')}`)).text()
  assert.match(exported, /工作年限/)
  assert.match(exported, /经验不详/)
})

test('invalid import rows do not reserve identity keys from later valid rows', async () => {
  const { url } = await startApp()
  const form = new FormData()
  form.append(
    'file',
    new Blob([Buffer.from('name,email\n,poison@example.com\nValid Candidate,poison@example.com\n')], { type: 'text/csv' }),
    'invalid-first.csv'
  )

  const preview = await requestJson(`${url}/api/import/preview`, { method: 'POST', body: form })
  assert.equal(preview.response.status, 200)
  assert.equal(preview.body.summary.invalid_rows, 1)
  assert.equal(preview.body.summary.file_duplicates, 0)
  assert.equal(preview.body.rows[0].errors[0].field, 'name')
  assert.equal(preview.body.rows[1].duplicate, null)

  const committed = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: preview.body.preview_token }
  })
  assert.equal(committed.response.status, 201)
  assert.equal(committed.body.imported_rows, 1)
  assert.equal(committed.body.failed_rows, 1)
  assert.equal(committed.body.skipped_rows, 0)

  const candidates = await requestJson(`${url}/api/candidates`)
  assert.equal(candidates.body.pagination.total, 1)
  assert.equal(Object.hasOwn(candidates.body.items[0], 'email'), false)
  const candidate = await requestJson(`${url}/api/candidates/${candidates.body.items[0].id}?include_sensitive=true`)
  assert.equal(candidate.body.email, 'poison@example.com')
})

test('import update rejects identity keys that resolve to different candidates', async () => {
  const { url } = await startApp()
  const createCandidate = (body) => requestJson(`${url}/api/candidates`, { method: 'POST', body })

  const candidateA = await createCandidate({
    name: 'Candidate A',
    email: 'a@example.com',
    phone: '13800138001'
  })
  const candidateB = await createCandidate({
    name: 'Candidate B',
    email: 'b@example.com',
    phone: '13900139002'
  })

  const sameCandidateForm = new FormData()
  sameCandidateForm.append(
    'file',
    new Blob([Buffer.from('name,email,phone\nSame,a@example.com,13800138001\n')], { type: 'text/csv' }),
    'same-candidate.csv'
  )
  const sameCandidatePreview = await requestJson(`${url}/api/import/preview`, {
    method: 'POST',
    body: sameCandidateForm
  })
  assert.equal(sameCandidatePreview.body.rows[0].errors.length, 0)
  assert.equal(sameCandidatePreview.body.rows[0].duplicate.id, candidateA.body.id)
  assert.equal(sameCandidatePreview.body.rows[0].duplicate.identity_conflict, undefined)
  assert.deepEqual(sameCandidatePreview.body.rows[0].duplicate.matched_fields, ['email', 'phone'])

  const conflictingForm = new FormData()
  conflictingForm.append(
    'file',
    new Blob([Buffer.from('name,email,phone\nConflict,a@example.com,13900139002\n')], { type: 'text/csv' }),
    'identity-conflict.csv'
  )
  const conflictingPreview = await requestJson(`${url}/api/import/preview`, {
    method: 'POST',
    body: conflictingForm
  })
  assert.equal(conflictingPreview.response.status, 200)
  assert.equal(conflictingPreview.body.rows[0].duplicate.identity_conflict, true)
  assert.equal(conflictingPreview.body.rows[0].duplicate.matched_by, 'identity_conflict')
  assert.equal(conflictingPreview.body.rows[0].errors[0].code, 'identity_conflict')

  const rejectedPreviewConflict = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: conflictingPreview.body.preview_token, on_duplicate: 'update' }
  })
  assert.equal(rejectedPreviewConflict.body.updated_rows, 0)
  assert.equal(rejectedPreviewConflict.body.failed_rows, 1)

  const afterA = await requestJson(`${url}/api/candidates/${candidateA.body.id}?include_sensitive=true`)
  const afterB = await requestJson(`${url}/api/candidates/${candidateB.body.id}?include_sensitive=true`)
  assert.equal(afterA.body.phone, '+8613800138001')
  assert.equal(afterB.body.phone, '+8613900139002')

  const candidateC = await createCandidate({
    name: 'Candidate C',
    email: 'c@example.com',
    phone: '13700137003'
  })
  const raceForm = new FormData()
  raceForm.append(
    'file',
    new Blob([Buffer.from('name,email,phone\nRace,c@example.com,13600136004\n')], { type: 'text/csv' }),
    'commit-time-conflict.csv'
  )
  const racePreview = await requestJson(`${url}/api/import/preview`, { method: 'POST', body: raceForm })
  assert.equal(racePreview.body.rows[0].errors.length, 0)
  assert.equal(racePreview.body.rows[0].duplicate.id, candidateC.body.id)

  await createCandidate({
    name: 'Candidate D',
    email: 'd@example.com',
    phone: '13600136004'
  })
  const rejectedCommitConflict = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: racePreview.body.preview_token, on_duplicate: 'update' }
  })
  assert.equal(rejectedCommitConflict.body.updated_rows, 0)
  assert.equal(rejectedCommitConflict.body.failed_rows, 1)
  assert.equal(rejectedCommitConflict.body.failures[0].errors[0].code, 'identity_conflict')
  assert.equal(rejectedCommitConflict.body.failures[0].conflict.length, 2)

  const afterC = await requestJson(`${url}/api/candidates/${candidateC.body.id}?include_sensitive=true`)
  assert.equal(afterC.body.phone, '+8613700137003')
})

test('CSV export neutralizes formula-leading cells without changing XLSX values', async () => {
  const { url } = await startApp()
  const created = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: {
      name: '=2+2',
      phone: '13800138000',
      current_company: '@command',
      source: '-source',
      owner: '+owner'
    }
  })
  assert.equal(created.response.status, 201)

  const csvExport = await fetch(`${url}/api/export?format=csv`)
  const csv = Buffer.from(await csvExport.arrayBuffer()).toString('utf8')
  assert.match(csv, /'=2\+2/)
  assert.match(csv, /'\+8613800138000/)
  assert.match(csv, /'@command/)
  assert.match(csv, /'-source/)
  assert.match(csv, /'\+owner/)

  const xlsxExport = await fetch(`${url}/api/export?format=xlsx`)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(await xlsxExport.arrayBuffer()))
  assert.equal(workbook.worksheets[0].getCell('B2').value, '=2+2')
})

test('Agent exposes the full SQLite read-only tool catalog and uses the simple pipeline fast path', async () => {
  const requests = []
  const mock = await listen(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(payload)
    res.setHeader('content-type', 'application/json')
    if (requests.length === 1) {
      res.end(JSON.stringify({
        model: 'test-model',
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: {
                name: 'aggregate_recruitment_data',
                arguments: JSON.stringify({ table: 'candidates', metrics: [{ operation: 'count' }] })
              }
            }]
          }
        }]
      }))
    } else {
      res.end(JSON.stringify({
        model: 'test-model',
        choices: [{ message: { role: 'assistant', content: '当前招聘管道为空。' } }]
      }))
    }
  })

  const directory = mkdtempSync(join(tmpdir(), 'candidate-agent-tools-'))
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }))
  const { url } = await startApp({
    databasePath: join(directory, 'agent.db'),
    agentExportRoot: join(directory, 'exports'),
    agentConfig: { baseUrl: `${mock.url}/v1`, apiKey: 'test-key', model: 'test-model' }
  })
  const status = await requestJson(`${url}/api/agent/status`)
  assert.equal(status.body.configured, true)
  assert.equal(status.body.read_only, true)
  assert.equal(status.body.full_readonly, true)
  assert.equal(status.body.readonly_connection, true)
  assert.equal(Object.hasOwn(status.body, 'endpoint'), false)
  assert.equal(JSON.stringify(status.body).includes('test-key'), false)
  assert.equal(status.body.tools.length, 20)
  for (const name of [
    'get_schema_catalog',
    'execute_readonly_query',
    'query_candidates',
    'get_candidate_full',
    'aggregate_recruitment_data',
    'search_all_records',
    'search_candidate_resumes',
    'get_attachment_text',
    'export_query_results',
    'search_web',
    'fetch_web_page'
  ]) assert.equal(status.body.tools.includes(name), true)

  const submission = await requestJson(`${url}/api/agent/query`, {
    method: 'POST',
    body: { message: '招聘管道情况如何？' }
  })
  assert.equal([200, 202].includes(submission.response.status), true)
  const answer = await waitForAgentTerminal(url, submission)
  assert.equal(answer.body.state ?? 'completed', 'completed', JSON.stringify(answer.body))
  assert.equal(answer.body.answer ?? answer.body.assistant_message?.content, '当前招聘管道为空。')
  const toolsUsed = answer.body.tools_used ?? answer.body.task?.tools_used ?? answer.body.assistant_message?.tools_used
  assert.deepEqual(toolsUsed.map((tool) => tool.name), ['execute_readonly_query'])
  assert.deepEqual(requests[0].tools, [])
  assert.equal(requests[0].tool_choice, 'none')
  assert.equal(Object.hasOwn(requests[0], 'temperature'), false)
  assert.equal(requests[0].tools.some((tool) => /update|delete/i.test(tool.function.name)), false)
})

test('Agent returns explicitly requested sensitive candidate fields through the isolated read-only tools', async () => {
  const requests = []
  let candidateId
  const mock = await listen(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(payload)
    res.setHeader('content-type', 'application/json')
    if (requests.length === 1) {
      res.end(JSON.stringify({
        model: 'test-model',
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'detail-call',
                type: 'function',
                function: { name: 'get_candidate_full', arguments: JSON.stringify({ candidate_id: candidateId, related_limit: 10 }) }
              },
              {
                id: 'search-call',
                type: 'function',
                function: {
                  name: 'query_candidates',
                  arguments: JSON.stringify({
                    filters: [{ field: 'id', operator: 'eq', value: candidateId }],
                    page_size: 1
                  })
                }
              },
              {
                id: 'notes-call',
                type: 'function',
                function: { name: 'query_candidate_notes', arguments: JSON.stringify({ candidate_id: candidateId, page_size: 10 }) }
              }
            ]
          }
        }]
      }))
    } else {
      res.end(JSON.stringify({
        model: 'test-model',
        choices: [{ message: { role: 'assistant', content: 'Full read-only result received.' } }]
      }))
    }
  })

  const directory = mkdtempSync(join(tmpdir(), 'candidate-agent-sensitive-'))
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }))
  const { url } = await startApp({
    databasePath: join(directory, 'agent.db'),
    agentExportRoot: join(directory, 'exports'),
    agentConfig: { baseUrl: `${mock.url}/v1`, apiKey: 'test-key', model: 'test-model' }
  })
  const salary = '88K-private-salary'
  const noteContent = 'private-note-token-7f4d2a'
  const created = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: {
      name: 'Privacy Test Candidate',
      phone: '13800138000',
      email: 'privacy.secret@example.com',
      expected_salary: salary,
      current_company: 'Privacy Labs',
      current_title: 'Security Engineer',
      location: 'Shanghai',
      source: 'Internal',
      owner: 'Recruiter One',
      tags: ['backend']
    }
  })
  assert.equal(created.response.status, 201)
  candidateId = created.body.id
  const note = await requestJson(`${url}/api/candidates/${candidateId}/notes`, {
    method: 'POST',
    body: { content: noteContent, author: 'Recruiter One' }
  })
  assert.equal(note.response.status, 201)

  const submission = await requestJson(`${url}/api/agent/query`, {
    method: 'POST',
    body: { message: `Summarize candidate ${candidateId}` }
  })
  assert.equal([200, 202].includes(submission.response.status), true)
  const answer = await waitForAgentTerminal(url, submission)
  assert.equal(answer.body.state, 'completed')
  assert.equal(requests.length, 2)

  const toolMessages = requests[1].messages.filter((message) => message.role === 'tool')
  const toolPayloads = Object.fromEntries(toolMessages.map((message) => [message.tool_call_id, JSON.parse(message.content)]))
  const serializedTools = JSON.stringify(toolMessages)
  assert.equal(serializedTools.includes(created.body.phone), true)
  assert.equal(serializedTools.includes(created.body.email), true)
  assert.equal(serializedTools.includes(salary), true)
  assert.equal(serializedTools.includes(noteContent), true)
  assert.match(serializedTools, /不可信(?:数据|资料)/)

  const detail = toolPayloads['detail-call'].result.candidate
  assert.equal(detail.phone, created.body.phone)
  assert.equal(detail.email, created.body.email)
  assert.equal(detail.expected_salary, salary)
  assert.equal(toolPayloads['detail-call'].result.related.notes.rows[0].content, noteContent)

  const searchCandidate = toolPayloads['search-call'].result.rows[0]
  assert.equal(searchCandidate.phone, created.body.phone)
  assert.equal(searchCandidate.email, created.body.email)
  assert.equal(searchCandidate.expected_salary, salary)
  assert.equal(toolPayloads['notes-call'].result.rows[0].content, noteContent)
})

test('structured import compatibility route remains idempotent without name-only matching', async () => {
  const { url } = await startApp()
  const payload = {
    filename: 'frontend-preview.xlsx',
    mapping: { 姓名: 'name', 邮箱: 'email', 阶段: 'stage' },
    rows: [
      { 姓名: '同名候选人', 邮箱: 'one@example.com', 阶段: '初筛' },
      { 姓名: '同名候选人', 邮箱: 'two@example.com', 阶段: '面试' }
    ]
  }
  const imported = await requestJson(`${url}/api/imports/candidates`, { method: 'POST', body: payload })
  assert.equal(imported.response.status, 201)
  assert.equal(imported.body.imported, 2)
  assert.equal(imported.body.duplicates, 0)

  const replay = await requestJson(`${url}/api/imports/candidates`, { method: 'POST', body: payload })
  assert.equal(replay.response.status, 201)
  assert.equal(replay.body.imported, 0)
  assert.equal(replay.body.duplicates, 2)
})

test('talent migration is idempotent and preserves legacy candidate rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-workbench-talent-migration-'))
  const databasePath = join(directory, 'legacy.db')
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }))

  let db = openDatabase(databasePath)
  const legacy = insertCandidate(db, {
    name: 'Legacy Talent',
    email: 'legacy-talent@example.com',
    stage: '筛选中'
  })
  const legacyPhotoUrl = 'https://images.example.test/legacy-photo.jpg?signature=legacy-value'
  const timestamp = new Date().toISOString()
  db.prepare(`
    INSERT INTO candidate_source_records(
      id, candidate_id, source_system, source_record_id, record_type, source_name,
      source_timestamp, raw_payload, sensitivity, created_at, updated_at
    ) VALUES (?, ?, 'beisen', ?, 'candidate', '北森导入', NULL, ?, 'high', ?, ?)
  `).run('legacy-photo-source', legacy.id, 'legacy-photo-candidate', JSON.stringify({
    证件照: legacyPhotoUrl,
    性别: '女',
    出生日期: '1992/08/16',
    年龄: '33岁'
  }), timestamp, timestamp)
  db.prepare('DELETE FROM schema_migrations WHERE version IN (4, 7)').run()
  db.close()

  db = openDatabase(databasePath)
  db.close()
  db = openDatabase(databasePath)
  try {
    const preserved = db.prepare('SELECT name, email, stage FROM candidates WHERE id = ?').get(legacy.id)
    assert.deepEqual({ ...preserved }, {
      name: 'Legacy Talent',
      email: 'legacy-talent@example.com',
      stage: '筛选中'
    })
    assert.deepEqual(
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
    )
    for (const table of [
      'talent_pools',
      'candidate_talent_pools',
      'candidate_profile_sections',
      'candidate_preferences',
      'candidate_source_records',
      'candidate_assessments',
      'candidate_consents',
      'candidate_position_sources'
    ]) {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count, 1)
    }
    const candidateColumns = new Set(db.prepare('PRAGMA table_info(candidates)').all().map((column) => column.name))
    for (const column of [
      'highest_school', 'highest_major', 'job_seeking_status', 'resume_updated_at', 'self_summary',
      'photo_url', 'gender', 'birth_date', 'age'
    ]) {
      assert.equal(candidateColumns.has(column), true, column)
    }
    assert.equal(db.prepare('SELECT photo_url FROM candidates WHERE id = ?').get(legacy.id).photo_url, legacyPhotoUrl)
    assert.deepEqual(
      { ...db.prepare('SELECT gender, birth_date, age FROM candidates WHERE id = ?').get(legacy.id) },
      { gender: '女', birth_date: '1992-08-16', age: 33 }
    )
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM activities WHERE candidate_id = ? AND type = 'candidate_photo_backfilled'`).get(legacy.id).count, 1)
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0)
  } finally {
    db.close()
  }
})

test('candidate photos are validated, protected in projections, and exposed through avatar redirects', async () => {
  const { url } = await startApp()
  const photoUrl = 'http://images.example.test/candidates/photo.jpg?signature=opaque-value'
  const created = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'Photo Candidate', photo_url: photoUrl }
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.has_photo, true)

  const list = await requestJson(`${url}/api/candidates`)
  assert.equal(list.body.items[0].has_photo, true)
  assert.equal(Object.hasOwn(list.body.items[0], 'photo_url'), false)

  const safeDetail = await requestJson(`${url}/api/candidates/${created.body.id}`)
  assert.equal(safeDetail.body.has_photo, true)
  assert.equal(Object.hasOwn(safeDetail.body, 'photo_url'), false)

  const sensitiveDetail = await requestJson(`${url}/api/candidates/${created.body.id}?include_sensitive=true`)
  assert.equal(sensitiveDetail.body.photo_url, photoUrl)

  const avatar = await fetch(`${url}/api/candidates/${created.body.id}/avatar`, { redirect: 'manual' })
  assert.equal(avatar.status, 302)
  assert.equal(avatar.headers.get('location'), photoUrl)
  assert.equal(avatar.headers.get('referrer-policy'), 'no-referrer')
  assert.match(avatar.headers.get('cache-control'), /private/)

  const exported = await fetch(`${url}/api/candidates/export?format=csv`)
  const exportedText = await exported.text()
  assert.equal(exportedText.includes('opaque-value'), false)
  assert.equal(exportedText.includes('证件照'), false)

  const withoutPhoto = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'No Photo Candidate' }
  })
  const missingAvatar = await requestJson(`${url}/api/candidates/${withoutPhoto.body.id}/avatar`)
  assert.equal(missingAvatar.response.status, 404)
  assert.equal(missingAvatar.body.error.code, 'avatar_not_found')

  for (const invalidPhotoUrl of [
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'file:///tmp/photo.jpg',
    'https://images.example.test/not-an-image',
    `https://images.example.test/${'x'.repeat(2048)}.jpg`
  ]) {
    const invalid = await requestJson(`${url}/api/candidates`, {
      method: 'POST',
      body: { name: 'Invalid Photo Candidate', photo_url: invalidPhotoUrl }
    })
    assert.equal(invalid.response.status, 422)
    assert.equal(invalid.body.error.details.some((error) => error.field === 'photo_url'), true)
  }
})

test('talent pool CRUD, association, filters, profile writes, and sensitive projections are controlled', async () => {
  const { url } = await startApp()
  const created = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: {
      name: 'Talent Profile Candidate',
      phone: '13800138123',
      email: 'talent-profile@example.com',
      expected_salary: 'private-salary',
      education: '硕士',
      highest_school: 'Example University',
      highest_major: 'Computer Science',
      job_seeking_status: '在看机会',
      self_summary: 'Long form summary',
      stage: '面试中'
    }
  })
  assert.equal(created.response.status, 201)

  const pool = await requestJson(`${url}/api/talent-pools`, {
    method: 'POST',
    body: { name: 'Engineering Pool', description: 'Core engineering talent', color: '#059669' }
  })
  assert.equal(pool.response.status, 201)
  assert.equal(pool.body.candidate_count, 0)

  const duplicatePool = await requestJson(`${url}/api/talent-pools`, {
    method: 'POST',
    body: { name: 'engineering pool' }
  })
  assert.equal(duplicatePool.response.status, 409)

  const linked = await requestJson(`${url}/api/talent-pools/${pool.body.id}/candidates`, {
    method: 'POST',
    body: { candidate_ids: [created.body.id, created.body.id] }
  })
  assert.equal(linked.response.status, 201)
  assert.equal(linked.body.input_count, 2)
  assert.equal(linked.body.linked_count, 1)
  assert.deepEqual(linked.body.linked_ids, [created.body.id])

  const preferences = await requestJson(`${url}/api/candidates/${created.body.id}/preferences`, {
    method: 'PUT',
    body: {
      employment_status: '在看机会',
      desired_titles: ['Platform Engineer', 'Platform Engineer'],
      desired_locations: ['Shanghai'],
      employment_type: 'Full-time',
      expected_salary: 'sensitive-preference-salary',
      availability: '30 days',
      raw_payload: { private_preference: 'secret-preference-value' }
    }
  })
  assert.equal(preferences.response.status, 200)
  assert.deepEqual(preferences.body.desired_titles, ['Platform Engineer'])

  const sections = await requestJson(`${url}/api/candidates/${created.body.id}/profile-sections`, {
    method: 'PUT',
    body: {
      sections: [
        { section_type: 'experience', title: 'Experience', content: 'Built a platform.', sensitivity: 'internal' },
        { section_type: 'other', title: 'Sensitive', content: 'high-sensitive-section', sensitivity: 'high' }
      ]
    }
  })
  assert.equal(sections.response.status, 200)
  assert.equal(sections.body.data.length, 2)

  const list = await requestJson(`${url}/api/candidates?pool_id=${pool.body.id}&education=${encodeURIComponent('硕士')}&school=${encodeURIComponent('Example University')}&major=${encodeURIComponent('Computer Science')}&job_seeking_status=${encodeURIComponent('在看机会')}`)
  assert.equal(list.response.status, 200)
  assert.equal(list.body.pagination.total, 1)
  assert.equal(list.body.items[0].talent_pools[0].id, pool.body.id)
  for (const field of ['phone', 'email', 'expected_salary', 'stage', 'source_record_id', 'self_summary']) {
    assert.equal(Object.hasOwn(list.body.items[0], field), false, field)
  }

  const safeDetail = await requestJson(`${url}/api/candidates/${created.body.id}`)
  assert.equal(Object.hasOwn(safeDetail.body, 'phone'), false)
  assert.equal(Object.hasOwn(safeDetail.body, 'email'), false)
  assert.equal(Object.hasOwn(safeDetail.body, 'stage'), false)
  assert.equal(safeDetail.body.profile_sections.length, 1)
  assert.equal(safeDetail.body.preferences.expected_salary, undefined)
  assert.equal(safeDetail.body.preferences.raw_payload, undefined)

  const sensitiveDetail = await requestJson(`${url}/api/candidates/${created.body.id}?include_sensitive=true&include_legacy_stage=true`)
  assert.equal(sensitiveDetail.body.phone, '+8613800138123')
  assert.equal(sensitiveDetail.body.email, 'talent-profile@example.com')
  assert.equal(sensitiveDetail.body.stage, '面试中')
  assert.equal(sensitiveDetail.body.profile_sections.length, 2)
  assert.equal(sensitiveDetail.body.preferences.expected_salary, 'sensitive-preference-salary')
  assert.equal(sensitiveDetail.body.preferences.raw_payload.private_preference, 'secret-preference-value')

  const dashboard = await requestJson(`${url}/api/dashboard`)
  assert.equal(dashboard.body.talent_summary.by_pool[0].count, 1)
  assert.equal(dashboard.body.talent_summary.by_education[0].education, '硕士')
  assert.equal(dashboard.body.talent_summary.by_job_seeking_status[0].status, '在看机会')

  const archivedPool = await requestJson(`${url}/api/talent-pools/${pool.body.id}/archive`, { method: 'POST' })
  assert.ok(archivedPool.body.archived_at)
  const blockedLink = await requestJson(`${url}/api/talent-pools/${pool.body.id}/candidates`, {
    method: 'POST',
    body: { candidate_ids: [created.body.id] }
  })
  assert.equal(blockedLink.response.status, 409)
  const restoredPool = await requestJson(`${url}/api/talent-pools/${pool.body.id}/restore`, { method: 'POST' })
  assert.equal(restoredPool.body.archived_at, null)

  const unlinked = await requestJson(`${url}/api/talent-pools/${pool.body.id}/candidates`, {
    method: 'DELETE',
    body: { candidate_ids: [created.body.id] }
  })
  assert.equal(unlinked.body.unlinked_count, 1)
  const activities = await requestJson(`${url}/api/candidates/${created.body.id}/activities`)
  assert.ok(activities.body.data.some((activity) => activity.type === 'talent_pool_linked'))
  assert.ok(activities.body.data.some((activity) => activity.type === 'talent_pool_unlinked'))
})

test('Beisen talent XLSX preview and commit use stable IDs, retain raw history, and replay without duplicate entities', async () => {
  const { url } = await startApp()
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('应聘者申请数据')
  sheet.addRow([
    '姓名', '应聘者Id', '应聘者ID', '申请ID', '职位编号', '职位名称',
    '手机号', '邮箱', '最高学历', '最高学历学校', '最高学历专业', '求职状态',
    '有效投递渠道', '最初投递渠道', '最后投递渠道', '应聘者关联人才库',
    '教育经历', '工作经历', '面试结论', '测评得分', '授权状态', '招聘负责人',
    '敏感证件信息'
  ])
  sheet.addRow([
    'Candidate One', '王一', 'C-1', 'A-1', 'P-1', 'Backend Engineer',
    '13800138001', 'one@example.com', '硕士', 'University One', 'Computer Science', '在看机会',
    'Referral', 'Campus', 'Referral', 'Engineering Pool',
    'Education raw one', 'Experience raw one', 'Strong', '92', 'agreed', 'Recruiter A',
    'private-id-one'
  ])
  sheet.addRow([
    'Candidate One', '王一', 'C-1', 'A-2', 'P-2', 'Platform Engineer',
    '13800138001', 'one@example.com', '硕士', 'University One', 'Computer Science', '在看机会',
    'Referral', 'Campus', 'Referral', 'Platform Pool',
    'Education raw one', 'Experience raw one', 'Strong', '95', 'agreed', 'Recruiter B',
    'private-id-one'
  ])
  sheet.addRow([
    'Candidate Two', '李二', 'C-2', 'A-3', 'P-1', 'Backend Engineer',
    '13800138002', 'two@example.com', '本科', 'University Two', 'Software Engineering', '暂不考虑',
    'Direct', 'Direct', 'Direct', 'Engineering Pool',
    'Education raw two', 'Experience raw two', 'Pass', '80', 'agreed', 'Recruiter A',
    'private-id-two'
  ])
  sheet.addRow([
    '', '', 'C-3', 'A-4', 'P-1', 'Backend Engineer',
    '', '', '本科', '', '', '', 'Direct', 'Direct', 'Direct', '', '', '', '', '', '', 'Recruiter A',
    'private-id-three'
  ])
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer())

  const previewWorkbook = async () => {
    const form = new FormData()
    form.append(
      'file',
      new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'beisen-talent.xlsx'
    )
    return requestJson(`${url}/api/import/preview`, { method: 'POST', body: form })
  }

  const preview = await previewWorkbook()
  assert.equal(preview.response.status, 200)
  assert.equal(preview.body.profile, 'beisen_talent')
  assert.equal(preview.body.mapping.source_record_id, '应聘者ID')
  assert.equal(preview.body.summary.total_rows, 4)
  assert.equal(preview.body.summary.candidate_records, 3)
  assert.equal(preview.body.summary.application_records, 3)
  assert.equal(preview.body.summary.position_records, 2)
  assert.equal(preview.body.summary.missing_identity_rows, 1)
  assert.equal(preview.body.position_preview.create_count, 2)

  const committed = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: preview.body.preview_token }
  })
  assert.equal(committed.response.status, 201)
  assert.equal(committed.body.profile, 'beisen_talent')
  assert.equal(committed.body.candidate_count, 2)
  assert.equal(committed.body.application_count, 3)
  assert.equal(committed.body.position_count, 2)
  assert.equal(committed.body.positions_created, 2)
  assert.equal(committed.body.links_created, 3)
  assert.equal(committed.body.failed_rows, 1)

  const candidates = await requestJson(`${url}/api/candidates?sort=name&order=asc`)
  assert.equal(candidates.body.pagination.total, 2)
  assert.equal(Object.hasOwn(candidates.body.items[0], 'phone'), false)
  assert.equal(Object.hasOwn(candidates.body.items[0], 'stage'), false)
  const candidateOne = candidates.body.items.find((candidate) => candidate.name === 'Candidate One')
  assert.equal(candidateOne.positions.length, 2)
  assert.equal(candidateOne.talent_pools.length, 2)

  const safeDetail = await requestJson(`${url}/api/candidates/${candidateOne.id}`)
  assert.ok(safeDetail.body.source_records.length >= 4)
  assert.ok(safeDetail.body.assessments.length >= 2)
  assert.ok(safeDetail.body.consents.length >= 1)
  assert.equal(safeDetail.body.position_sources.length, 2)
  assert.equal(safeDetail.body.source_records.every((record) => !Object.hasOwn(record, 'raw_payload')), true)
  assert.equal(safeDetail.body.assessments.every((record) => !Object.hasOwn(record, 'raw_payload')), true)
  assert.equal(JSON.stringify(safeDetail.body).includes('private-id-one'), false)

  const sensitiveDetail = await requestJson(`${url}/api/candidates/${candidateOne.id}?include_sensitive=true`)
  assert.equal(sensitiveDetail.body.phone, '+8613800138001')
  assert.equal(sensitiveDetail.body.source_records.some((record) => record.raw_payload?.['敏感证件信息'] === 'private-id-one'), true)
  assert.equal(sensitiveDetail.body.assessments.some((record) => record.raw_payload?.['面试结论'] === 'Strong'), true)
  assert.equal(sensitiveDetail.body.position_sources.some((record) => record.raw_payload?.['敏感证件信息'] === 'private-id-one'), true)

  const replayPreview = await previewWorkbook()
  assert.equal(replayPreview.body.position_preview.match_count, 2)
  const replayCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: replayPreview.body.preview_token }
  })
  assert.equal(replayCommit.body.candidate_count, 2)
  assert.equal(replayCommit.body.positions_created, 0)
  assert.equal(replayCommit.body.positions_matched, 2)
  assert.equal(replayCommit.body.links_created, 0)
  assert.equal(replayCommit.body.pools_created, 0)
  const replayCandidates = await requestJson(`${url}/api/candidates`)
  assert.equal(replayCandidates.body.pagination.total, 2)
})

test('Beisen candidate-only imports merge sparse rows, preserve raw fields, and make relations optional', async () => {
  const { url } = await startApp()

  const initialPreview = await previewImportWorkbook(url, [
    '应聘者ID', '姓名', '手机号', '当前公司', '标签', '旧字段'
  ], [[
    'INC-1', 'Incremental Candidate', '13800138088', 'Original Company', '已有标签', '保留值'
  ]], 'beisen-candidate-only-initial.xlsx')
  assert.equal(initialPreview.response.status, 200)
  assert.equal(initialPreview.body.profile, 'beisen_talent')
  assert.equal(initialPreview.body.summary.candidate_records, 1)
  assert.equal(initialPreview.body.summary.application_records, 0)
  assert.equal(initialPreview.body.summary.position_records, 0)
  assert.equal(initialPreview.body.summary.valid_rows, 1)

  const initialCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: initialPreview.body.preview_token }
  })
  assert.equal(initialCommit.response.status, 201)
  assert.equal(initialCommit.body.imported_rows, 1)
  assert.equal(initialCommit.body.application_count, 0)
  assert.equal(initialCommit.body.position_count, 0)

  const sparsePreview = await previewImportWorkbook(url, [
    '应聘者ID', '姓名', '当前职位', '所在地', '标签', '旧字段', '新字段甲', '新字段乙', '申请ID', '面试结论'
  ], [
    ['INC-1', 'Updated Candidate', 'Senior Engineer', '', '新增标签', '', '甲值', '', 'APP-WITHOUT-POSITION', '待关联'],
    ['INC-1', '', '', '上海', '已有标签，第二标签', '', '', '乙值', '', '']
  ], 'beisen-candidate-only-sparse.xlsx')
  assert.equal(sparsePreview.response.status, 200)
  assert.equal(sparsePreview.body.summary.valid_rows, 2)
  assert.equal(sparsePreview.body.summary.candidate_records, 1)
  assert.equal(sparsePreview.body.summary.application_records, 0)
  assert.equal(sparsePreview.body.summary.position_records, 0)
  assert.equal(sparsePreview.body.summary.skipped_application_rows, 1)
  assert.equal(sparsePreview.body.rows[0].candidate.name, 'Updated Candidate')
  assert.equal(sparsePreview.body.rows[0].candidate.current_title, 'Senior Engineer')
  assert.equal(sparsePreview.body.rows[0].candidate.location, '上海')
  assert.deepEqual(sparsePreview.body.rows[0].candidate.tags, ['新增标签', '已有标签', '第二标签'])

  const sparseCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: sparsePreview.body.preview_token }
  })
  assert.equal(sparseCommit.response.status, 201)
  assert.equal(sparseCommit.body.updated_rows, 2)
  assert.equal(
    sparseCommit.body.imported_rows + sparseCommit.body.updated_rows +
      sparseCommit.body.skipped_rows + sparseCommit.body.failed_rows,
    sparsePreview.body.summary.total_rows
  )
  assert.equal(sparseCommit.body.candidate_count, 1)
  assert.equal(sparseCommit.body.application_count, 0)
  assert.equal(sparseCommit.body.position_count, 0)

  const candidates = await requestJson(`${url}/api/candidates`)
  const imported = candidates.body.items.find((candidate) => candidate.source_system === 'beisen')
  assert.ok(imported)
  assert.equal(imported.name, 'Updated Candidate')
  assert.equal(imported.current_company, 'Original Company')
  assert.equal(imported.current_title, 'Senior Engineer')
  assert.equal(imported.location, '上海')
  assert.deepEqual(imported.tags, ['已有标签', '新增标签', '第二标签'])

  const sensitiveDetail = await requestJson(`${url}/api/candidates/${imported.id}?include_sensitive=true`)
  assert.equal(sensitiveDetail.body.phone, '+8613800138088')
  assert.equal(sensitiveDetail.body.position_sources.length, 0, 'application without a position must not create a position source')
  assert.equal(sensitiveDetail.body.assessments.length, 1, 'assessment with a stable application ID may be retained without a position')
  const candidateSource = sensitiveDetail.body.source_records.find((record) => record.record_type === 'candidate')
  assert.equal(candidateSource.raw_payload['旧字段'], '保留值')
  assert.equal(candidateSource.raw_payload['新字段甲'], '甲值')
  assert.equal(candidateSource.raw_payload['新字段乙'], '乙值')
  assert.equal(candidateSource.raw_payload['面试结论'], '待关联')

  const positionOnlyPreview = await previewImportWorkbook(url, [
    '应聘者ID', '职位编号', '职位名称', '职位部门'
  ], [[
    'INC-1', 'POS-OPTIONAL-1', 'Optional Position', 'Platform'
  ]], 'beisen-position-without-application.xlsx')
  assert.equal(positionOnlyPreview.body.summary.valid_rows, 1)
  assert.equal(positionOnlyPreview.body.summary.position_records, 1)
  assert.equal(positionOnlyPreview.body.summary.application_records, 0)
  const positionOnlyCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: positionOnlyPreview.body.preview_token }
  })
  assert.equal(positionOnlyCommit.body.positions_created, 1)
  assert.equal(positionOnlyCommit.body.links_created, 1)
  assert.equal(positionOnlyCommit.body.application_count, 0)

  const existingPositionPreview = await previewImportWorkbook(url, [
    '应聘者ID', '职位编号', '当前公司'
  ], [[
    'INC-1', 'POS-OPTIONAL-1', 'Updated Company'
  ]], 'beisen-existing-position-code-only.xlsx')
  assert.equal(existingPositionPreview.body.summary.valid_rows, 1)
  assert.equal(existingPositionPreview.body.position_preview.match_count, 1)
  const existingPositionCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: existingPositionPreview.body.preview_token }
  })
  assert.equal(existingPositionCommit.body.positions_matched, 1)
  assert.equal(existingPositionCommit.body.links_created, 0)

  const incompletePositionPreview = await previewImportWorkbook(url, [
    '应聘者ID', '职位编号', '最高学历'
  ], [[
    'INC-1', 'POS-WITHOUT-TITLE', '硕士'
  ]], 'beisen-incomplete-new-position.xlsx')
  assert.equal(incompletePositionPreview.body.summary.valid_rows, 0)
  assert.equal(incompletePositionPreview.body.summary.invalid_rows, 1)
  assert.equal(incompletePositionPreview.body.summary.position_records, 0)
  assert.equal(incompletePositionPreview.body.summary.skipped_position_rows, 1)
  assert.equal(incompletePositionPreview.body.position_preview.invalid_count, 1)
  assert.ok(incompletePositionPreview.body.rows[0].errors.some((error) => (
    error.code === 'missing_position_title'
  )))
  const incompletePositionCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: incompletePositionPreview.body.preview_token }
  })
  assert.equal(incompletePositionCommit.body.updated_rows, 0)
  assert.equal(incompletePositionCommit.body.failed_rows, 1)
  assert.equal(incompletePositionCommit.body.position_count, 0)

  const finalDetail = await requestJson(`${url}/api/candidates/${imported.id}?include_sensitive=true`)
  assert.equal(finalDetail.body.current_company, 'Updated Company')
  assert.equal(finalDetail.body.education, null)
  assert.equal(finalDetail.body.positions.length, 1)
  assert.equal(finalDetail.body.positions[0].title, 'Optional Position')
  assert.equal(finalDetail.body.position_sources.length, 0)
})

test('Beisen incremental imports require names for new IDs and reject contact conflicts for existing IDs', async () => {
  const { url } = await startApp()

  const initialPreview = await previewImportWorkbook(url, [
    '应聘者ID', '姓名', '邮箱'
  ], [[
    'CONFLICT-1', 'Stable Candidate', 'stable@example.com'
  ]], 'beisen-conflict-initial.xlsx')
  const initialCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: initialPreview.body.preview_token }
  })
  assert.equal(initialCommit.body.imported_rows, 1)

  const missingNamePreview = await previewImportWorkbook(url, [
    '应聘者ID', '邮箱'
  ], [[
    'NEW-WITHOUT-NAME', 'new-without-name@example.com'
  ]], 'beisen-new-without-name.xlsx')
  assert.equal(missingNamePreview.body.summary.invalid_rows, 1)
  assert.equal(missingNamePreview.body.rows[0].errors.some((error) => error.code === 'missing_identity'), true)
  const missingNameCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: missingNamePreview.body.preview_token }
  })
  assert.equal(missingNameCommit.body.imported_rows, 0)
  assert.equal(missingNameCommit.body.failed_rows, 1)

  const other = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'Other Candidate', email: 'occupied@example.com', phone: '+8613900139001' }
  })
  assert.equal(other.response.status, 201)

  const previewConflict = await previewImportWorkbook(url, [
    '应聘者ID', '邮箱', '当前公司'
  ], [[
    'CONFLICT-1', 'occupied@example.com', 'Must Not Apply'
  ]], 'beisen-existing-contact-conflict.xlsx')
  assert.equal(previewConflict.body.summary.invalid_rows, 1)
  assert.equal(previewConflict.body.rows[0].errors.some((error) => error.code === 'identity_conflict'), true)
  const previewConflictCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: previewConflict.body.preview_token }
  })
  assert.equal(previewConflictCommit.body.updated_rows, 0)
  assert.equal(previewConflictCommit.body.failed_rows, 1)

  const phoneConflict = await previewImportWorkbook(url, [
    '应聘者ID', '手机号', '当前公司'
  ], [[
    'CONFLICT-1', '13900139001', 'Must Not Apply By Phone'
  ]], 'beisen-existing-phone-conflict.xlsx')
  assert.equal(phoneConflict.body.summary.invalid_rows, 1)
  assert.equal(phoneConflict.body.rows[0].errors.some((error) => error.code === 'identity_conflict'), true)
  const phoneConflictCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: phoneConflict.body.preview_token }
  })
  assert.equal(phoneConflictCommit.body.updated_rows, 0)
  assert.equal(phoneConflictCommit.body.failed_rows, 1)

  const racePreview = await previewImportWorkbook(url, [
    '应聘者ID', '邮箱', '当前公司'
  ], [[
    'CONFLICT-1', 'race@example.com', 'Must Also Not Apply'
  ]], 'beisen-existing-contact-race.xlsx')
  assert.equal(racePreview.body.summary.valid_rows, 1)
  const raceOwner = await requestJson(`${url}/api/candidates`, {
    method: 'POST',
    body: { name: 'Race Owner', email: 'race@example.com' }
  })
  assert.equal(raceOwner.response.status, 201)
  const raceCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: racePreview.body.preview_token }
  })
  assert.equal(raceCommit.body.updated_rows, 0)
  assert.equal(raceCommit.body.failed_rows, 1)
  assert.equal(raceCommit.body.failures[0].errors[0].code, 'identity_conflict')

  const candidates = await requestJson(`${url}/api/candidates`)
  assert.equal(candidates.body.pagination.total, 3, 'invalid new ID must not create a candidate')
  const stable = candidates.body.items.find((candidate) => candidate.name === 'Stable Candidate')
  const stableDetail = await requestJson(`${url}/api/candidates/${stable.id}?include_sensitive=true`)
  assert.equal(stableDetail.body.email, 'stable@example.com')
  assert.equal(stableDetail.body.current_company, null)
})

test('Beisen photo fields can be added later by the same stable candidate ID without leaking signed URLs in preview', async () => {
  const { url } = await startApp()
  const initialPreview = await previewImportWorkbook(url, [
    '应聘者ID', '姓名', '当前公司'
  ], [[
    'PHOTO-INCREMENTAL-1', 'Incremental Photo Candidate', 'Original Company'
  ]], 'beisen-photo-initial.xlsx')
  const initialCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: initialPreview.body.preview_token }
  })
  assert.equal(initialCommit.body.imported_rows, 1)

  const photoUrl = 'http://images.example.test/candidates/incremental.jpg?signature=private-value'
  const photoPreview = await previewImportWorkbook(url, [
    '应聘者ID', '证件照'
  ], [[
    'PHOTO-INCREMENTAL-1', photoUrl
  ]], 'beisen-photo-follow-up.xlsx')
  assert.equal(photoPreview.response.status, 200)
  assert.equal(photoPreview.body.summary.valid_rows, 1)
  assert.equal(photoPreview.body.rows[0].candidate.has_photo, true)
  assert.equal(Object.hasOwn(photoPreview.body.rows[0].candidate, 'photo_url'), false)
  assert.equal(JSON.stringify(photoPreview.body.rows).includes('private-value'), false)

  const photoCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: photoPreview.body.preview_token }
  })
  assert.equal(photoCommit.body.imported_rows, 0)
  assert.equal(photoCommit.body.updated_rows, 1)

  const candidates = await requestJson(`${url}/api/candidates`)
  assert.equal(candidates.body.pagination.total, 1)
  assert.equal(candidates.body.items[0].has_photo, true)
  assert.equal(Object.hasOwn(candidates.body.items[0], 'photo_url'), false)
  const detail = await requestJson(`${url}/api/candidates/${candidates.body.items[0].id}?include_sensitive=true`)
  assert.equal(detail.body.photo_url, photoUrl)
})

test('Beisen rows sharing a new position code merge metadata and link every candidate once', async () => {
  const { url } = await startApp()
  const preview = await previewImportWorkbook(url, [
    '应聘者ID', '姓名', '职位编号', '职位名称', '职位部门', '职位工作地点', '招聘负责人'
  ], [
    ['POSITION-MERGE-A', 'Position Merge Candidate A', 'POS-MERGE-1', 'Shared Platform Role', '', '上海', ''],
    ['POSITION-MERGE-B', 'Position Merge Candidate B', 'POS-MERGE-1', '', 'Engineering', '', 'Recruiter Shared']
  ], 'beisen-shared-position.xlsx')

  assert.equal(preview.response.status, 200)
  assert.equal(preview.body.summary.valid_rows, 2)
  assert.equal(preview.body.summary.candidate_records, 2)
  assert.equal(preview.body.summary.position_records, 1)
  assert.equal(preview.body.position_preview.create_count, 1)
  for (const row of preview.body.rows) {
    assert.equal(row.position.external_code, 'POS-MERGE-1')
    assert.equal(row.position.title, 'Shared Platform Role')
    assert.equal(row.position.department, 'Engineering')
    assert.equal(row.position.location, '上海')
    assert.equal(row.position.owner, 'Recruiter Shared')
  }

  const committed = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: preview.body.preview_token }
  })
  assert.equal(committed.response.status, 201)
  assert.equal(committed.body.candidate_count, 2)
  assert.equal(committed.body.position_count, 1)
  assert.equal(committed.body.positions_created, 1)
  assert.equal(committed.body.links_created, 2)

  const positions = await requestJson(`${url}/api/positions?search=POS-MERGE-1`)
  assert.equal(positions.body.pagination.total, 1)
  const position = positions.body.items[0]
  assert.equal(position.title, 'Shared Platform Role')
  assert.equal(position.department, 'Engineering')
  assert.equal(position.location, '上海')
  assert.equal(position.owner, 'Recruiter Shared')
  assert.equal(position.candidate_count, 2)
  const linked = await requestJson(`${url}/api/candidates?position_id=${position.id}&sort=name&order=asc`)
  assert.deepEqual(linked.body.items.map((candidate) => candidate.name), [
    'Position Merge Candidate A',
    'Position Merge Candidate B'
  ])
})

test('Beisen application IDs cannot move between candidates at preview or after a preview race', async () => {
  const { url } = await startApp()
  const seedPreview = await previewImportWorkbook(url, [
    '应聘者ID', '姓名', '当前公司'
  ], [
    ['APPLICATION-OWNER-A', 'Application Owner A', 'Owner Original'],
    ['APPLICATION-CHALLENGER-B', 'Application Challenger B', 'Challenger Original']
  ], 'beisen-application-candidates.xlsx')
  const seedCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: seedPreview.body.preview_token }
  })
  assert.equal(seedCommit.body.imported_rows, 2)

  const ownerPreview = await previewImportWorkbook(url, [
    '应聘者ID', '申请ID', '职位编号', '职位名称', '面试结论'
  ], [[
    'APPLICATION-OWNER-A', 'APPLICATION-OWNED-1', 'POS-APPLICATION-1', 'Owned Application Role', 'Owner Assessment'
  ]], 'beisen-application-owner.xlsx')
  const ownerCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: ownerPreview.body.preview_token }
  })
  assert.equal(ownerCommit.body.updated_rows, 1)
  assert.equal(ownerCommit.body.application_count, 1)

  const partialConflictPreview = await previewImportWorkbook(url, [
    '应聘者ID', '当前公司', '申请ID', '面试结论'
  ], [
    ['APPLICATION-CHALLENGER-B', 'Must Not Partially Apply', '', ''],
    ['APPLICATION-CHALLENGER-B', '', 'APPLICATION-OWNED-1', 'Challenger Assessment']
  ], 'beisen-application-assessment-conflict.xlsx')
  assert.equal(partialConflictPreview.body.summary.invalid_rows, 2)
  assert.equal(partialConflictPreview.body.summary.application_records, 0)
  assert.equal(partialConflictPreview.body.summary.skipped_application_rows, 1)
  assert.equal(partialConflictPreview.body.rows.every((row) => (
    row.errors.some((error) => error.code === 'application_identity_conflict')
  )), true)
  const partialConflictCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: partialConflictPreview.body.preview_token }
  })
  assert.equal(partialConflictCommit.body.updated_rows, 0)
  assert.equal(partialConflictCommit.body.failed_rows, 2)
  assert.equal(partialConflictCommit.body.candidate_count, 0)

  const positionConflictPreview = await previewImportWorkbook(url, [
    '应聘者ID', '当前职位', '申请ID', '职位编号', '职位名称'
  ], [[
    'APPLICATION-CHALLENGER-B', 'Must Not Apply By Position', 'APPLICATION-OWNED-1',
    'POS-APPLICATION-1', 'Owned Application Role'
  ]], 'beisen-application-position-conflict.xlsx')
  assert.equal(positionConflictPreview.body.summary.invalid_rows, 1)
  assert.equal(positionConflictPreview.body.rows[0].errors.some((error) => (
    error.code === 'application_identity_conflict'
  )), true)
  const positionConflictCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: positionConflictPreview.body.preview_token }
  })
  assert.equal(positionConflictCommit.body.updated_rows, 0)
  assert.equal(positionConflictCommit.body.failed_rows, 1)

  const stalePreview = await previewImportWorkbook(url, [
    '应聘者ID', '当前公司', '申请ID', '职位编号', '职位名称', '面试结论'
  ], [[
    'APPLICATION-CHALLENGER-B', 'Must Not Apply After Race', 'APPLICATION-RACE-1',
    'POS-APPLICATION-RACE', 'Race Application Role', 'Stale Challenger Assessment'
  ]], 'beisen-application-race-stale.xlsx')
  assert.equal(stalePreview.body.summary.valid_rows, 1)

  const raceOwnerPreview = await previewImportWorkbook(url, [
    '应聘者ID', '申请ID', '职位编号', '职位名称', '面试结论'
  ], [[
    'APPLICATION-OWNER-A', 'APPLICATION-RACE-1', 'POS-APPLICATION-RACE',
    'Race Application Role', 'Owner Race Assessment'
  ]], 'beisen-application-race-owner.xlsx')
  const raceOwnerCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: raceOwnerPreview.body.preview_token }
  })
  assert.equal(raceOwnerCommit.body.updated_rows, 1)
  assert.equal(raceOwnerCommit.body.application_count, 1)

  const staleCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: stalePreview.body.preview_token }
  })
  assert.equal(staleCommit.response.status, 201)
  assert.equal(staleCommit.body.updated_rows, 0)
  assert.equal(staleCommit.body.failed_rows, 1)
  assert.equal(staleCommit.body.candidate_count, 0)
  assert.equal(staleCommit.body.failures[0].errors[0].code, 'application_identity_conflict')

  const candidates = await requestJson(`${url}/api/candidates?page_size=100`)
  const owner = candidates.body.items.find((candidate) => candidate.name === 'Application Owner A')
  const challenger = candidates.body.items.find((candidate) => candidate.name === 'Application Challenger B')
  const ownerDetail = await requestJson(`${url}/api/candidates/${owner.id}?include_sensitive=true`)
  const challengerDetail = await requestJson(`${url}/api/candidates/${challenger.id}?include_sensitive=true`)
  assert.deepEqual(
    ownerDetail.body.position_sources.map((record) => record.source_application_id).sort(),
    ['APPLICATION-OWNED-1', 'APPLICATION-RACE-1']
  )
  assert.deepEqual(
    ownerDetail.body.assessments.map((record) => record.source_record_id).sort(),
    ['APPLICATION-OWNED-1', 'APPLICATION-RACE-1']
  )
  const ownedAssessment = ownerDetail.body.assessments.find((record) => (
    record.source_record_id === 'APPLICATION-OWNED-1'
  ))
  assert.equal(ownedAssessment.raw_payload['面试结论'], 'Owner Assessment')
  assert.equal(challengerDetail.body.current_company, 'Challenger Original')
  assert.equal(challengerDetail.body.current_title, null)
  assert.equal(challengerDetail.body.position_sources.length, 0)
  assert.equal(challengerDetail.body.assessments.length, 0)
})

test('Beisen multi-row counts are conserved and tags stay capped at 50 across batches', async () => {
  const { url } = await startApp()
  const tags = (start, end) => Array.from(
    { length: end - start + 1 },
    (_, index) => `tag-${String(start + index).padStart(2, '0')}`
  )
  const initialPreview = await previewImportWorkbook(url, [
    '应聘者ID', '姓名', '标签', '当前公司'
  ], [
    ['COUNTED-CANDIDATE-1', 'Counted Candidate', tags(1, 20).join('，'), 'Initial Company'],
    ['COUNTED-CANDIDATE-1', '', tags(21, 40).join('，'), '']
  ], 'beisen-multi-row-counts.xlsx')
  assert.equal(initialPreview.body.summary.total_rows, 2)
  assert.equal(initialPreview.body.summary.valid_rows, 2)
  assert.equal(initialPreview.body.summary.candidate_records, 1)
  assert.equal(initialPreview.body.rows[0].candidate.tags.length, 40)

  const initialCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: initialPreview.body.preview_token }
  })
  assert.equal(initialCommit.body.imported_rows, 1)
  assert.equal(initialCommit.body.updated_rows, 1)
  assert.equal(initialCommit.body.skipped_rows, 0)
  assert.equal(initialCommit.body.failed_rows, 0)
  assert.equal(initialCommit.body.candidate_count, 1)
  assert.equal(
    initialCommit.body.imported_rows + initialCommit.body.updated_rows +
      initialCommit.body.skipped_rows + initialCommit.body.failed_rows,
    initialPreview.body.summary.total_rows
  )

  const tagLimitPreview = await previewImportWorkbook(url, [
    '应聘者ID', '标签'
  ], [[
    'COUNTED-CANDIDATE-1', tags(41, 80).join('，')
  ]], 'beisen-tag-limit-follow-up.xlsx')
  assert.equal(tagLimitPreview.body.summary.valid_rows, 1)
  const tagLimitCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: tagLimitPreview.body.preview_token }
  })
  assert.equal(tagLimitCommit.body.updated_rows, 1)
  assert.equal(
    tagLimitCommit.body.imported_rows + tagLimitCommit.body.updated_rows +
      tagLimitCommit.body.skipped_rows + tagLimitCommit.body.failed_rows,
    tagLimitPreview.body.summary.total_rows
  )

  const candidates = await requestJson(`${url}/api/candidates`)
  assert.equal(candidates.body.pagination.total, 1)
  assert.equal(candidates.body.items[0].name, 'Counted Candidate')
  assert.deepEqual(candidates.body.items[0].tags, tags(1, 50))
})

test('invalid Beisen rows cannot leak fields or raw payload into a valid row with the same candidate ID', async () => {
  const { url } = await startApp()
  const preview = await previewImportWorkbook(url, [
    '应聘者ID', '姓名', '邮箱', '当前公司', '失败行字段'
  ], [
    ['INVALID-ISOLATION-1', 'Valid Candidate', '', 'Company A', ''],
    ['INVALID-ISOLATION-1', '', 'not-an-email', 'Company B', 'must-not-leak']
  ], 'beisen-invalid-row-isolation.xlsx')

  assert.equal(preview.body.summary.total_rows, 2)
  assert.equal(preview.body.summary.valid_rows, 1)
  assert.equal(preview.body.summary.invalid_rows, 1)
  assert.equal(preview.body.rows[1].errors.some((error) => error.field === 'email'), true)
  assert.equal(preview.body.rows[0].candidate.current_company, 'Company A')

  const committed = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: preview.body.preview_token }
  })
  assert.equal(committed.body.imported_rows, 1)
  assert.equal(committed.body.updated_rows, 0)
  assert.equal(committed.body.failed_rows, 1)
  assert.equal(committed.body.candidate_count, 1)

  const candidates = await requestJson(`${url}/api/candidates`)
  assert.equal(candidates.body.pagination.total, 1)
  const detail = await requestJson(
    `${url}/api/candidates/${candidates.body.items[0].id}?include_sensitive=true`
  )
  assert.equal(detail.body.current_company, 'Company A')
  const candidateSource = detail.body.source_records.find((record) => record.record_type === 'candidate')
  assert.equal(candidateSource.raw_payload['当前公司'], 'Company A')
  assert.notEqual(candidateSource.raw_payload['失败行字段'], 'must-not-leak')
  assert.equal(JSON.stringify(candidateSource.raw_payload).includes('not-an-email'), false)
  assert.equal(JSON.stringify(candidateSource.raw_payload).includes('Company B'), false)
})

test('invalid duplicate applications cannot leak position fields into a valid row sharing the position code', async () => {
  const { url } = await startApp()
  const preview = await previewImportWorkbook(url, [
    '应聘者ID', '姓名', '申请ID', '职位编号', '职位名称', '职位部门'
  ], [
    ['POSITION-VALID-CANDIDATE', 'Position Valid Candidate', 'DUPLICATE-APPLICATION-1', 'P1', 'Good', 'Valid Department'],
    ['POSITION-INVALID-CANDIDATE', 'Position Invalid Candidate', 'DUPLICATE-APPLICATION-1', 'P1', 'Bad', 'Invalid Department']
  ], 'beisen-invalid-position-isolation.xlsx')

  assert.equal(preview.response.status, 200)
  assert.equal(preview.body.summary.total_rows, 2)
  assert.equal(preview.body.summary.valid_rows, 1)
  assert.equal(preview.body.summary.invalid_rows, 1)
  assert.equal(preview.body.summary.position_records, 1)
  assert.equal(preview.body.rows[1].errors.some((error) => error.code === 'duplicate_application_id'), true)
  assert.equal(preview.body.position_preview.create_count, 1)
  assert.equal(preview.body.position_preview.items[0].external_code, 'P1')
  assert.equal(preview.body.position_preview.items[0].title, 'Good')

  const committed = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: preview.body.preview_token }
  })
  assert.equal(committed.response.status, 201)
  assert.equal(committed.body.imported_rows, 1)
  assert.equal(committed.body.failed_rows, 1)
  assert.equal(committed.body.candidate_count, 1)
  assert.equal(committed.body.position_count, 1)
  assert.equal(committed.body.positions_created, 1)
  assert.equal(committed.body.links_created, 1)
  assert.equal(committed.body.application_count, 1)

  const positions = await requestJson(`${url}/api/positions?search=P1`)
  assert.equal(positions.body.pagination.total, 1)
  assert.equal(positions.body.items[0].title, 'Good')
  assert.equal(positions.body.items[0].department, 'Valid Department')
  assert.equal(positions.body.items[0].candidate_count, 1)
  const candidates = await requestJson(`${url}/api/candidates?page_size=100`)
  assert.deepEqual(candidates.body.items.map((candidate) => candidate.name), ['Position Valid Candidate'])
  const detail = await requestJson(
    `${url}/api/candidates/${candidates.body.items[0].id}?include_sensitive=true`
  )
  assert.equal(detail.body.position_sources.length, 1)
  const applicationPayload = detail.body.position_sources[0].raw_payload
  assert.equal(applicationPayload['职位名称'], 'Good')
  assert.equal(applicationPayload['职位部门'], 'Valid Department')
  assert.equal(JSON.stringify(applicationPayload).includes('Bad'), false)
  assert.equal(JSON.stringify(applicationPayload).includes('Invalid Department'), false)
})

test('new position codes without titles fail rows before optional application handling', async () => {
  const { url } = await startApp()
  const sharedPreview = await previewImportWorkbook(url, [
    '应聘者ID', '姓名', '申请ID', '职位编号', '当前公司'
  ], [
    ['OPTIONAL-RELATION-A', 'Optional Relation Candidate A', 'OPTIONAL-APPLICATION-1', 'UNKNOWN-POSITION-A', 'Company A'],
    ['OPTIONAL-RELATION-B', 'Optional Relation Candidate B', 'OPTIONAL-APPLICATION-1', 'UNKNOWN-POSITION-B', 'Company B']
  ], 'beisen-optional-shared-application.xlsx')

  assert.equal(sharedPreview.response.status, 200)
  assert.equal(sharedPreview.body.summary.total_rows, 2)
  assert.equal(sharedPreview.body.summary.valid_rows, 0)
  assert.equal(sharedPreview.body.summary.invalid_rows, 2)
  assert.equal(sharedPreview.body.summary.file_duplicates, 0)
  assert.equal(sharedPreview.body.summary.candidate_records, 2)
  assert.equal(sharedPreview.body.summary.application_records, 0)
  assert.equal(sharedPreview.body.summary.position_records, 0)
  assert.equal(sharedPreview.body.summary.skipped_application_rows, 2)
  assert.equal(sharedPreview.body.summary.skipped_position_rows, 2)
  assert.equal(sharedPreview.body.rows.every((row) => row.errors.some((error) => (
    error.code === 'missing_position_title'
  ))), true)

  const sharedCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: sharedPreview.body.preview_token }
  })
  assert.equal(sharedCommit.response.status, 201)
  assert.equal(sharedCommit.body.imported_rows, 0)
  assert.equal(sharedCommit.body.failed_rows, 2)
  assert.equal(sharedCommit.body.candidate_count, 0)
  assert.equal(sharedCommit.body.application_count, 0)
  assert.equal(sharedCommit.body.position_count, 0)
  assert.equal(sharedCommit.body.links_created, 0)

  const ownerPreview = await previewImportWorkbook(url, [
    '应聘者ID', '姓名', '申请ID', '职位编号', '职位名称'
  ], [[
    'OPTIONAL-RELATION-OWNER', 'Optional Relation Owner', 'OWNED-OPTIONAL-APPLICATION',
    'OWNED-OPTIONAL-POSITION', 'Owned Optional Position'
  ]], 'beisen-optional-application-owner.xlsx')
  const ownerCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: ownerPreview.body.preview_token }
  })
  assert.equal(ownerCommit.body.imported_rows, 1)
  assert.equal(ownerCommit.body.application_count, 1)

  const ownedButUnusedPreview = await previewImportWorkbook(url, [
    '应聘者ID', '姓名', '申请ID', '职位编号', '当前公司'
  ], [[
    'OPTIONAL-RELATION-C', 'Optional Relation Candidate C', 'OWNED-OPTIONAL-APPLICATION',
    'UNKNOWN-POSITION-C', 'Company C'
  ]], 'beisen-owned-but-unused-application.xlsx')
  assert.equal(ownedButUnusedPreview.response.status, 200)
  assert.equal(ownedButUnusedPreview.body.summary.valid_rows, 0)
  assert.equal(ownedButUnusedPreview.body.summary.invalid_rows, 1)
  assert.equal(ownedButUnusedPreview.body.summary.application_records, 0)
  assert.equal(ownedButUnusedPreview.body.summary.position_records, 0)
  assert.equal(ownedButUnusedPreview.body.rows[0].errors.some((error) => (
    error.code === 'application_identity_conflict'
  )), false)
  assert.equal(ownedButUnusedPreview.body.rows[0].errors.some((error) => (
    error.code === 'missing_position_title'
  )), true)
  const ownedButUnusedCommit = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: ownedButUnusedPreview.body.preview_token }
  })
  assert.equal(ownedButUnusedCommit.body.imported_rows, 0)
  assert.equal(ownedButUnusedCommit.body.failed_rows, 1)
  assert.equal(ownedButUnusedCommit.body.application_count, 0)
  assert.equal(ownedButUnusedCommit.body.position_count, 0)

  const candidates = await requestJson(`${url}/api/candidates?page_size=100`)
  assert.equal(candidates.body.pagination.total, 1)
  const owner = candidates.body.items.find((candidate) => candidate.name === 'Optional Relation Owner')
  const ownerDetail = await requestJson(`${url}/api/candidates/${owner.id}?include_sensitive=true`)
  assert.deepEqual(ownerDetail.body.position_sources.map((record) => record.source_application_id), [
    'OWNED-OPTIONAL-APPLICATION'
  ])
})

test('Beisen assessment classification excludes self summaries and Offer or hiring evaluation fields', async () => {
  const { url } = await startApp()
  const preview = await previewImportWorkbook(url, [
    '应聘者ID', '姓名', '申请ID', '自我评价', 'Offer评价', '录用评价', '面试评价'
  ], [
    ['ASSESSMENT-CLASSIFICATION-1', 'Assessment Classification Candidate', 'APPLICATION-SELF-SUMMARY',
      'Candidate self summary', '', '', ''],
    ['ASSESSMENT-CLASSIFICATION-1', '', 'APPLICATION-OFFER-HIRING',
      '', 'Offer archive evaluation', 'Hiring archive evaluation', ''],
    ['ASSESSMENT-CLASSIFICATION-1', '', 'APPLICATION-INTERVIEW',
      '', '', '', 'Real interview evaluation']
  ], 'beisen-assessment-classification.xlsx')

  assert.equal(preview.response.status, 200)
  assert.equal(preview.body.summary.total_rows, 3)
  assert.equal(preview.body.summary.valid_rows, 3)
  assert.equal(preview.body.summary.candidate_records, 1)
  assert.equal(preview.body.summary.application_records, 0)
  assert.equal(preview.body.summary.position_records, 0)
  assert.equal(preview.body.rows[0].candidate.self_summary, 'Candidate self summary')
  assert.equal(preview.body.rows.every((row) => row.errors.length === 0), true)

  const committed = await requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: preview.body.preview_token }
  })
  assert.equal(committed.response.status, 201)
  assert.equal(committed.body.imported_rows, 1)
  assert.equal(committed.body.updated_rows, 2)
  assert.equal(committed.body.failed_rows, 0)
  assert.equal(committed.body.candidate_count, 1)
  assert.equal(committed.body.application_count, 0)
  assert.equal(committed.body.position_count, 0)

  const candidates = await requestJson(`${url}/api/candidates`)
  const detail = await requestJson(
    `${url}/api/candidates/${candidates.body.items[0].id}?include_sensitive=true`
  )
  assert.equal(detail.body.self_summary, 'Candidate self summary')
  assert.equal(detail.body.assessments.length, 1)
  assert.equal(detail.body.assessments[0].source_record_id, 'APPLICATION-INTERVIEW')
  assert.deepEqual(detail.body.assessments[0].raw_payload, {
    '面试评价': 'Real interview evaluation'
  })

  const candidateSource = detail.body.source_records.find((record) => record.record_type === 'candidate')
  assert.equal(candidateSource.raw_payload['自我评价'], 'Candidate self summary')
  assert.equal(candidateSource.raw_payload['Offer评价'], 'Offer archive evaluation')
  assert.equal(candidateSource.raw_payload['录用评价'], 'Hiring archive evaluation')
  assert.equal(candidateSource.raw_payload['面试评价'], 'Real interview evaluation')
  assert.equal(detail.body.assessments.some((record) => (
    ['APPLICATION-SELF-SUMMARY', 'APPLICATION-OFFER-HIRING'].includes(record.source_record_id)
  )), false)
})
