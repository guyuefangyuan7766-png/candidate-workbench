import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import http from 'node:http'
import { test } from 'node:test'
import ExcelJS from 'exceljs'
import { createApp } from '../../server/app.js'

const XLS_FIXTURE_GZIP_BASE64 = 'H4sIAAAAAAAEAO1YTUhUURT+7psZnTF/ZkwDDeQhZGWCRJs2Oqmj1kIzE7II6tnMQqwZmSbQFmXZ0CooWhVtDFvUwmrTnwW1CFoESi2CINBaCkFQ0EJ9nXPeGxttBGehobxvuOfee+793rnvnnN/5k1OBKZGHpdPYwnq4cK86UNOmk5R8qUqflC7aXIxlXspmQ7WFXxecmSOB+MF73PZh+zvaWh45H5DEvhK6Tj60R6LRvQ1RKOMwVA8hjrlptjTcIdSIcpkXMUiT4ncLPKh9H0pcp9oromso75T6hgmgu3Ve+047tYqpa2QpMJT4XwWzW6U4h3H8cXryurrQUO81zi9URoq3PkYBfm6NRKNxLlehHvIA0Kh2ra22qOEKZRQHIzil6kDP1ML/rXu6NdWr0D634v1ucvovaTNpPeRc5fqb2puYAjmScXRn0QBBt3c4kHXYH/kbJIWzA3Z9/PQGYmGDb2ld8CYxX6OGkm00Tef6U1EookIEbuMAYOykJEwNgGNDe1NB/Vu/XBtgwtoCjUSoSMeC59LxHKkrocOULTB2nj8izaeAlmO+STDKJJyQBalnyzO3v/xoa2nI3hCNENy2FhH0jZ+HZi4xAwiF0qLvBEdYkC1MHaJvCxP3SrlcpEl9NqUV3WU2oWWYelzRVqryM4ewcfg9rTyDionZw49q0h+C+6k8ljr9PmSsU/BEVTSlIfFGQrDqFE16vYtxvNgKlf25vVFZNk/G5lX89tjNy2PqSLM8QolBERaNZ4dtVDT7LlitsrAVsLm+XhF9pWwxxVvpA+EzTwtA08TntvmWT55oXislW81m+dawvNoXtHx+JjlEtZ3Om4CmHGztXqtGE/40bRV/8VaxIW2INdrXKiMceFJ872W0fc8kxe0PNv3V+8qywvI5AUHDhw4cODAwQaGdV2wLsp8XeJrBF8U+O7F33XmKM3/528UDlYPnYjRL0H/EJsRpTyOwaziZws8KvUstUJO6nsh4whZj6MPPTKOvqxsM+jKrNLfZ8VEf9amlkPW9uezGecq2/8DycqEggAWAAA='

async function withApp(run) {
  const app = createApp({ databasePath: ':memory:' })
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    await run(`http://127.0.0.1:${server.address().port}`, app.locals.db)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    app.closeDatabase()
  }
}

async function responseJson(response) {
  const text = await response.text()
  return text ? JSON.parse(text) : null
}

async function requestJson(url, { method = 'GET', body } = {}) {
  const isForm = body instanceof FormData
  const response = await fetch(url, {
    method,
    headers: body === undefined || isForm ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body)
  })
  return { response, body: await responseJson(response) }
}

async function previewFile(url, { buffer, filename, type, mapping, sourceSystem }) {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type }), filename)
  if (mapping) form.append('mapping', JSON.stringify(mapping))
  if (sourceSystem) form.append('source_system', sourceSystem)
  return requestJson(`${url}/api/import/preview`, { method: 'POST', body: form })
}

async function commitPreview(url, preview, onDuplicate = 'skip') {
  return requestJson(`${url}/api/import/commit`, {
    method: 'POST',
    body: { preview_token: preview.body.preview_token, on_duplicate: onDuplicate }
  })
}

async function workbookBuffer(headers, rows) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Candidates')
  sheet.addRow(headers)
  for (const row of rows) sheet.addRow(row)
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

test('generic CSV import previews, creates, links, and replays one stable position idempotently', async () => {
  await withApp(async (url) => {
    const csv = Buffer.from([
      '姓名,邮箱,职位名称,职位编号,职位部门,职位工作地点,招聘负责人',
      'Candidate A,candidate-a@example.com,Platform Engineer,PLAT-001,,,',
      'Candidate B,candidate-b@example.com,Platform Engineer,PLAT-001,Engineering,Shanghai,Recruiter One'
    ].join('\n'))

    const preview = await previewFile(url, {
      buffer: csv,
      filename: 'position-import.csv',
      type: 'text/csv',
      sourceSystem: 'legacy_hr'
    })
    assert.equal(preview.response.status, 200)
    assert.equal(preview.body.mapping.position_title, '职位名称')
    assert.equal(preview.body.mapping.position_external_code, '职位编号')
    assert.equal(preview.body.mapping.position_owner, '招聘负责人')
    assert.equal(preview.body.position_preview.create_count, 1)
    assert.equal(preview.body.position_preview.match_count, 0)
    assert.equal(preview.body.position_preview.link_count, 2)
    assert.equal(preview.body.position_preview.items[0].action, 'create')
    assert.equal(preview.body.position_preview.items[0].reason, 'no_existing_position')
    assert.equal(preview.body.position_preview.items[0].department, 'Engineering')
    assert.equal(preview.body.position_preview.items[0].location, 'Shanghai')

    const committed = await commitPreview(url, preview)
    assert.equal(committed.response.status, 201)
    assert.equal(committed.body.imported_rows, 2)
    assert.equal(committed.body.positions_created, 1)
    assert.equal(committed.body.links_created, 2)
    assert.equal(committed.body.position_count, 1)

    const positions = await requestJson(`${url}/api/positions?search=PLAT-001`)
    assert.equal(positions.body.pagination.total, 1)
    assert.equal(positions.body.items[0].status, 'draft')
    assert.equal(positions.body.items[0].candidate_count, 2)
    assert.equal(positions.body.items[0].source_system, 'legacy_hr')
    assert.equal(positions.body.items[0].external_code, 'PLAT-001')
    assert.equal(positions.body.items[0].department, 'Engineering')
    assert.equal(positions.body.items[0].location, 'Shanghai')
    assert.equal(positions.body.items[0].owner, 'Recruiter One')

    const replayPreview = await previewFile(url, {
      buffer: csv,
      filename: 'position-import.csv',
      type: 'text/csv',
      sourceSystem: 'legacy_hr'
    })
    assert.equal(replayPreview.body.position_preview.create_count, 0)
    assert.equal(replayPreview.body.position_preview.match_count, 1)
    assert.equal(replayPreview.body.position_preview.link_count, 2)
    const replay = await commitPreview(url, replayPreview)
    assert.equal(replay.body.positions_created, 0)
    assert.equal(replay.body.positions_matched, 1)
    assert.equal(replay.body.links_created, 0)
    assert.equal(replay.body.skipped_rows, 2)
  })
})

test('XLSX and XLSM position matching honors stable ids, normalized triples, title ambiguity, and archives', async () => {
  await withApp(async (url) => {
    const exact = await requestJson(`${url}/api/positions`, {
      method: 'POST',
      body: {
        title: 'Original Stable Role',
        department: 'Original Department',
        location: 'Original Location',
        source_system: 'source_a',
        external_code: 'STABLE-1'
      }
    })
    assert.equal(exact.response.status, 201)

    const stableBuffer = await workbookBuffer(
      ['姓名', '邮箱', '招聘职位', '职位编号', '职位部门', '职位工作地点'],
      [['Stable Candidate', 'stable-candidate@example.com', 'Different Display Title', 'STABLE-1', 'Other', 'Elsewhere']]
    )
    const stablePreview = await previewFile(url, {
      buffer: stableBuffer,
      filename: 'stable-position.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sourceSystem: 'source_a'
    })
    assert.equal(stablePreview.body.position_preview.match_count, 1)
    assert.equal(stablePreview.body.position_preview.items[0].position_id, exact.body.id)
    assert.equal(stablePreview.body.position_preview.items[0].reason, 'stable_id_match')
    const stableCommit = await commitPreview(url, stablePreview)
    assert.equal(stableCommit.body.positions_created, 0)
    assert.equal(stableCommit.body.links_created, 1)

    const normalized = await requestJson(`${url}/api/positions`, {
      method: 'POST',
      body: { title: 'Data Engineer', department: 'Data Platform', location: 'Shenzhen' }
    })
    const normalizedBuffer = await workbookBuffer(
      ['姓名', '邮箱', '职位名称', '职位部门', '职位工作地点'],
      [['Normalized Candidate', 'normalized@example.com', '  Ｄａｔａ   Engineer ', 'data   platform', 'Ｓｈｅｎｚｈｅｎ']]
    )
    const normalizedPreview = await previewFile(url, {
      buffer: normalizedBuffer,
      filename: 'normalized-position.xlsm',
      type: 'application/vnd.ms-excel.sheet.macroEnabled.12'
    })
    assert.equal(normalizedPreview.response.status, 200)
    assert.equal(normalizedPreview.body.position_preview.match_count, 1)
    assert.equal(normalizedPreview.body.position_preview.items[0].position_id, normalized.body.id)
    assert.equal(normalizedPreview.body.position_preview.items[0].reason, 'title_department_location_match')

    await requestJson(`${url}/api/positions`, {
      method: 'POST',
      body: {
        title: 'Stable Identity Role',
        department: 'Platform',
        location: 'Guangzhou',
        source_system: 'source_a',
        external_code: 'OLD-ID'
      }
    })
    const newStableIdBuffer = await workbookBuffer(
      ['姓名', '邮箱', '招聘职位', '职位编号', '职位部门', '职位工作地点'],
      [['New Stable Candidate', 'new-stable@example.com', 'Stable Identity Role', 'NEW-ID', 'Platform', 'Guangzhou']]
    )
    const newStableIdPreview = await previewFile(url, {
      buffer: newStableIdBuffer,
      filename: 'new-stable-id.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sourceSystem: 'source_a'
    })
    assert.equal(newStableIdPreview.body.position_preview.create_count, 1)
    assert.equal(newStableIdPreview.body.position_preview.match_count, 0)
    assert.equal(newStableIdPreview.body.position_preview.items[0].action, 'create')
    const newStableIdCommit = await commitPreview(url, newStableIdPreview)
    assert.equal(newStableIdCommit.body.positions_created, 1)
    const stableIdentityPositions = await requestJson(`${url}/api/positions?search=Stable%20Identity%20Role`)
    assert.equal(stableIdentityPositions.body.pagination.total, 2)

    await requestJson(`${url}/api/positions`, { method: 'POST', body: { title: 'Ambiguous Role' } })
    await requestJson(`${url}/api/positions`, { method: 'POST', body: { title: 'Ambiguous Role' } })
    const ambiguousBuffer = await workbookBuffer(
      ['姓名', '邮箱', '招聘职位'],
      [['Ambiguous Candidate', 'ambiguous@example.com', 'Ambiguous Role']]
    )
    const ambiguousPreview = await previewFile(url, {
      buffer: ambiguousBuffer,
      filename: 'ambiguous.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
    assert.equal(ambiguousPreview.body.summary.invalid_rows, 1)
    assert.equal(ambiguousPreview.body.position_preview.ambiguous_count, 1)
    assert.equal(ambiguousPreview.body.position_preview.items[0].action, 'ambiguous')
    const ambiguousCommit = await commitPreview(url, ambiguousPreview)
    assert.equal(ambiguousCommit.body.failed_rows, 1)
    assert.equal(ambiguousCommit.body.imported_rows, 0)

    const archived = await requestJson(`${url}/api/positions`, {
      method: 'POST',
      body: { title: 'Archived Role' }
    })
    await requestJson(`${url}/api/positions/${archived.body.id}/archive`, { method: 'POST' })
    const archivedBuffer = await workbookBuffer(
      ['姓名', '邮箱', '招聘职位'],
      [['Archived Candidate', 'archived@example.com', 'Archived Role']]
    )
    const archivedPreview = await previewFile(url, {
      buffer: archivedBuffer,
      filename: 'archived.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
    assert.equal(archivedPreview.body.summary.invalid_rows, 1)
    assert.equal(archivedPreview.body.position_preview.archived_conflict_count, 1)
    assert.equal(archivedPreview.body.position_preview.items[0].action, 'archived_conflict')
  })
})

test('generic and Beisen imports reject a stable position id without a position title', async () => {
  await withApp(async (url) => {
    const genericBuffer = await workbookBuffer(
      ['\u59d3\u540d', '\u90ae\u7bb1', '\u804c\u4f4d\u7f16\u53f7'],
      [['Invalid Generic Position', 'invalid-generic@example.test', 'GENERIC-NO-TITLE']]
    )
    const genericPreview = await previewFile(url, {
      buffer: genericBuffer,
      filename: 'generic-missing-position-title.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
    assert.equal(genericPreview.response.status, 200)
    assert.equal(genericPreview.body.summary.invalid_rows, 1)
    assert.equal(genericPreview.body.position_preview.invalid_count, 1)
    assert.equal(genericPreview.body.rows[0].position_resolution.action, 'invalid')
    assert.ok(genericPreview.body.rows[0].errors.some((error) => error.code === 'missing_position_title'))

    const genericCommit = await commitPreview(url, genericPreview)
    assert.equal(genericCommit.response.status, 201)
    assert.equal(genericCommit.body.failed_rows, 1)
    assert.equal(genericCommit.body.imported_rows, 0)
    assert.equal(genericCommit.body.positions_created, 0)
    assert.equal(genericCommit.body.links_created, 0)

    const beisenBuffer = await workbookBuffer(
      ['\u5e94\u8058\u8005ID', '\u59d3\u540d', '\u804c\u4f4d\u7f16\u53f7'],
      [['BEISEN-NO-TITLE-CANDIDATE', 'Invalid Beisen Position', 'BEISEN-NO-TITLE']]
    )
    const beisenPreview = await previewFile(url, {
      buffer: beisenBuffer,
      filename: 'beisen-missing-position-title.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
    assert.equal(beisenPreview.response.status, 200)
    assert.equal(beisenPreview.body.profile, 'beisen_talent')
    assert.equal(beisenPreview.body.summary.invalid_rows, 1)
    assert.equal(beisenPreview.body.position_preview.invalid_count, 1)
    assert.equal(beisenPreview.body.rows[0].position_resolution.action, 'invalid')
    assert.ok(beisenPreview.body.rows[0].errors.some((error) => error.code === 'missing_position_title'))

    const beisenCommit = await commitPreview(url, beisenPreview)
    assert.equal(beisenCommit.response.status, 201)
    assert.equal(beisenCommit.body.failed_rows, 1)
    assert.equal(beisenCommit.body.imported_rows, 0)
    assert.equal(beisenCommit.body.positions_created, 0)
    assert.equal(beisenCommit.body.links_created, 0)

    const candidates = await requestJson(`${url}/api/candidates?archived=include`)
    const positions = await requestJson(`${url}/api/positions?archived=include`)
    assert.equal(candidates.body.pagination.total, 0)
    assert.equal(positions.body.pagination.total, 0)
  })
})

test('generic and Beisen import commits roll back candidates, auto-created positions, and links on failure', async () => {
  await withApp(async (url, db) => {
    const assertImportRolledBack = () => {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count, 0)
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM positions').get().count, 0)
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidate_positions').get().count, 0)
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 0)
    }
    const installFailureTrigger = () => db.exec(`
      CREATE TRIGGER force_import_link_failure
      BEFORE INSERT ON candidate_positions
      BEGIN
        SELECT RAISE(ABORT, 'forced candidate-position link failure');
      END;
    `)

    const genericBuffer = await workbookBuffer(
      ['\u59d3\u540d', '\u90ae\u7bb1', '\u804c\u4f4d\u540d\u79f0', '\u804c\u4f4d\u7f16\u53f7'],
      [['Rollback Generic Candidate', 'rollback-generic@example.test', 'Rollback Generic Position', 'ROLLBACK-GENERIC']]
    )
    const genericPreview = await previewFile(url, {
      buffer: genericBuffer,
      filename: 'generic-rollback.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
    assert.equal(genericPreview.body.position_preview.create_count, 1)
    assert.equal(genericPreview.body.position_preview.link_count, 1)

    installFailureTrigger()
    const genericCommit = await commitPreview(url, genericPreview)
    assert.equal(genericCommit.response.status, 500)
    assert.equal(genericCommit.body.error.code, 'internal_error')
    assert.equal(genericCommit.body.error.message, '服务器内部错误，请稍后重试')
    assert.doesNotMatch(JSON.stringify(genericCommit.body), /candidate_positions|trigger|constraint|sqlite/i)
    assertImportRolledBack()
    db.exec('DROP TRIGGER force_import_link_failure')

    const beisenBuffer = await workbookBuffer(
      ['\u5e94\u8058\u8005ID', '\u59d3\u540d', '\u804c\u4f4d\u540d\u79f0', '\u804c\u4f4d\u7f16\u53f7'],
      [['ROLLBACK-BEISEN-CANDIDATE', 'Rollback Beisen Candidate', 'Rollback Beisen Position', 'ROLLBACK-BEISEN']]
    )
    const beisenPreview = await previewFile(url, {
      buffer: beisenBuffer,
      filename: 'beisen-rollback.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
    assert.equal(beisenPreview.body.profile, 'beisen_talent')
    assert.equal(beisenPreview.body.position_preview.create_count, 1)
    assert.equal(beisenPreview.body.position_preview.link_count, 1)

    installFailureTrigger()
    const beisenCommit = await commitPreview(url, beisenPreview)
    assert.equal(beisenCommit.response.status, 500)
    assert.equal(beisenCommit.body.error.code, 'internal_error')
    assert.equal(beisenCommit.body.error.message, '服务器内部错误，请稍后重试')
    assert.doesNotMatch(JSON.stringify(beisenCommit.body), /candidate_positions|trigger|constraint|sqlite/i)
    assertImportRolledBack()
  })
})

test('current job titles never create positions and BIFF8 supports explicit position mapping', async () => {
  await withApp(async (url) => {
    const currentJobCsv = Buffer.from('姓名,邮箱,当前职位\nCurrent Candidate,current@example.com,Principal Engineer')
    const currentPreview = await previewFile(url, {
      buffer: currentJobCsv,
      filename: 'current-job.csv',
      type: 'text/csv'
    })
    assert.equal(currentPreview.body.mapping.current_title, '当前职位')
    assert.equal(Object.hasOwn(currentPreview.body.mapping, 'position_title'), false)
    assert.equal(currentPreview.body.position_preview.create_count, 0)
    assert.equal(currentPreview.body.position_preview.link_count, 0)
    const currentCommit = await commitPreview(url, currentPreview)
    assert.equal(currentCommit.body.positions_created, 0)
    assert.equal(currentCommit.body.links_created, 0)

    const xlsPreview = await previewFile(url, {
      buffer: gunzipSync(Buffer.from(XLS_FIXTURE_GZIP_BASE64, 'base64')),
      filename: 'mapped-position.xls',
      type: 'application/vnd.ms-excel',
      mapping: { name: 'Emitente', position_title: 'Taxa' }
    })
    assert.equal(xlsPreview.response.status, 200)
    assert.equal(xlsPreview.body.mapping.position_title, 'Taxa')
    assert.ok(xlsPreview.body.position_preview.create_count > 0)
    assert.ok(xlsPreview.body.position_preview.link_count > 0)
  })
})

test('generic and Beisen imports cannot update or relate archived candidates', async () => {
  await withApp(async (url) => {
    const genericCandidate = await requestJson(`${url}/api/candidates`, {
      method: 'POST',
      body: {
        name: 'Archived Generic Candidate',
        email: 'archived-generic@example.com',
        current_company: 'Original Company'
      }
    })
    await requestJson(`${url}/api/candidates/${genericCandidate.body.id}/archive`, { method: 'POST' })
    const genericCsv = Buffer.from([
      '姓名,邮箱,当前公司,招聘职位',
      'Archived Generic Candidate,archived-generic@example.com,Changed Company,Blocked Generic Role'
    ].join('\n'))
    const genericPreview = await previewFile(url, {
      buffer: genericCsv,
      filename: 'archived-generic.csv',
      type: 'text/csv'
    })
    assert.equal(genericPreview.body.summary.invalid_rows, 1)
    assert.equal(genericPreview.body.rows[0].errors[0].code, 'candidate_archived')
    assert.equal(genericPreview.body.position_preview.create_count, 0)
    const genericCommit = await commitPreview(url, genericPreview, 'update')
    assert.equal(genericCommit.body.failed_rows, 1)
    assert.equal(genericCommit.body.positions_created, 0)
    assert.equal(genericCommit.body.links_created, 0)
    const genericDetail = await requestJson(`${url}/api/candidates/${genericCandidate.body.id}?include_sensitive=true`)
    assert.equal(genericDetail.body.current_company, 'Original Company')

    const beisenCandidate = await requestJson(`${url}/api/candidates`, {
      method: 'POST',
      body: {
        name: 'Archived Beisen Candidate',
        email: 'archived-beisen@example.com',
        source_system: 'beisen',
        source_record_id: 'ARCHIVED-BEISEN-1'
      }
    })
    await requestJson(`${url}/api/candidates/${beisenCandidate.body.id}/archive`, { method: 'POST' })
    const beisenBuffer = await workbookBuffer(
      ['应聘者ID', '姓名', '招聘职位'],
      [['ARCHIVED-BEISEN-1', 'Changed Beisen Name', 'Blocked Beisen Role']]
    )
    const beisenPreview = await previewFile(url, {
      buffer: beisenBuffer,
      filename: 'archived-beisen.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
    assert.equal(beisenPreview.body.profile, 'beisen_talent')
    assert.equal(beisenPreview.body.summary.invalid_rows, 1)
    assert.ok(beisenPreview.body.rows[0].errors.some((error) => error.code === 'candidate_archived'))
    assert.equal(beisenPreview.body.position_preview.create_count, 0)
    const beisenCommit = await commitPreview(url, beisenPreview)
    assert.equal(beisenCommit.body.failed_rows, 1)
    assert.equal(beisenCommit.body.positions_created, 0)
    assert.equal(beisenCommit.body.links_created, 0)

    const blockedPositions = await requestJson(`${url}/api/positions?search=Blocked`)
    assert.equal(blockedPositions.body.pagination.total, 0)
  })
})
