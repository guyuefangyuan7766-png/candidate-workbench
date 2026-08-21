import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import http from 'node:http'
import { test } from 'node:test'
import ExcelJS from 'exceljs'
import { createApp } from '../../server/app.js'

// Anonymous BIFF8 workbook from xls-reader's MIT-licensed sample corpus.
const XLS_FIXTURE_GZIP_BASE64 = 'H4sIAAAAAAAEAO1YTUhUURT+7psZnTF/ZkwDDeQhZGWCRJs2Oqmj1kIzE7II6tnMQqwZmSbQFmXZ0CooWhVtDFvUwmrTnwW1CFoESi2CINBaCkFQ0EJ9nXPeGxttBGehobxvuOfee+793rnvnnN/5k1OBKZGHpdPYwnq4cK86UNOmk5R8qUqflC7aXIxlXspmQ7WFXxecmSOB+MF73PZh+zvaWh45H5DEvhK6Tj60R6LRvQ1RKOMwVA8hjrlptjTcIdSIcpkXMUiT4ncLPKh9H0pcp9oromso75T6hgmgu3Ve+047tYqpa2QpMJT4XwWzW6U4h3H8cXryurrQUO81zi9URoq3PkYBfm6NRKNxLlehHvIA0Kh2ra22qOEKZRQHIzil6kDP1ML/rXu6NdWr0D634v1ucvovaTNpPeRc5fqb2puYAjmScXRn0QBBt3c4kHXYH/kbJIWzA3Z9/PQGYmGDb2ld8CYxX6OGkm00Tef6U1EookIEbuMAYOykJEwNgGNDe1NB/Vu/XBtgwtoCjUSoSMeC59LxHKkrocOULTB2nj8izaeAlmO+STDKJJyQBalnyzO3v/xoa2nI3hCNENy2FhH0jZ+HZi4xAwiF0qLvBEdYkC1MHaJvCxP3SrlcpEl9NqUV3WU2oWWYelzRVqryM4ewcfg9rTyDionZw49q0h+C+6k8ljr9PmSsU/BEVTSlIfFGQrDqFE16vYtxvNgKlf25vVFZNk/G5lX89tjNy2PqSLM8QolBERaNZ4dtVDT7LlitsrAVsLm+XhF9pWwxxVvpA+EzTwtA08TntvmWT55oXislW81m+dawvNoXtHx+JjlEtZ3Om4CmHGztXqtGE/40bRV/8VaxIW2INdrXKiMceFJ872W0fc8kxe0PNv3V+8qywvI5AUHDhw4cODAwQaGdV2wLsp8XeJrBF8U+O7F33XmKM3/528UDlYPnYjRL0H/EJsRpTyOwaziZws8KvUstUJO6nsh4whZj6MPPTKOvqxsM+jKrNLfZ8VEf9amlkPW9uezGecq2/8DycqEggAWAAA='

// The same anonymous fixture with its BIFF8 shared-string headers set to exact Beisen field names.
const BEISEN_XLS_FIXTURE_GZIP_BASE64 = 'H4sIAAAAAAAACu2YS2hTQRSGv5nkNje1jyRWQYVyKfguFHHjpo2t8dFFa62CjYia2ixKpZFYwbrQ+iiuBEU3ihvFLnThY+OrCroQXAiKLgRBaHUpCIKCi7ZX5uSmtjWCWVhR7g/3zMyZ+WfOnXPmwbx8ER25fHvhKDPQQIAJN0zJFJ0CwvlCBCZc1zXZfGoDro9/CmE7AiUWw+XPQ8aHxt+jaG4Fn6CB98BO9tOa6U07s4gmsSGljA31KohCcwlNBQvErpjIvSLnirwpbR+KXCua0yLriTGidvAi3rpijRfHHbpG6irQKO4K561oVjGPZyaOj55RubYWjdnu1L7/paI6WMZVQrAx3ZvOmnIlQ5RCIlHX0lKXTCaTI1RRwlW+ug58yS/4x46vn129woFv0/WhX+htVEF9mKGf9Od0EAZw9ygT/YOU0x80NRbb+venDwwS46zs+6W0p3u7Us6G7kOpMTaZqJHPQp3f1TFgDTSTMCvodbJ8m4ZEag40Nbau2+x0OFvrGgOwLtEUgrZsputgX6ZEyk6iudQcJLLxRKZtPOWyHMvQdFEp+agsygg2Y9c+v2rpbIvvFs2AHDa5I2mx+R1cjhlGGbpCauSPCAArhLFS5HHpdZHkF4qswjLpkrZ5XmbDCWlzUmqXYLNa8Dq+dEp+GTaDH7fcqx78EF+OzY2No4erbryJX6aGMF3iDMUJalWtunjB4H48nypv83oncsFPG5mtI57tbs5jqpJxs0KBqMhcycyOmixpb64MWxVgK2Gb+XhETKyLMqzMRnpd2IanC/C08IIeL+eTB8rYWvNUe7zADJ6lbdEZ+wwrIKxPrutG+Rg0ozXoGHdM16zlB2YjLvSk/FfjQhWMC2uK73VB35uZPKJLPd+fuqJyXqCQF3z48OHDhw8f/zGUdxkKeFdmy7tyhbx3nXHXdSf+9iOFjz+GdjJk6MNhPb30kaW/qPiZj6Xyfanf5OTfCw22kyFLD51iR0+x4WuuzGrq//w2MVL0UL9C0eNPFGPnHx7/O0crYmYAFgAA'

async function withApp(run) {
  const app = createApp({ databasePath: ':memory:' })
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
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

test('legacy BIFF8 .xls files reach the normal preview pipeline', async () => {
  await withApp(async (url) => {
    const form = new FormData()
    form.append(
      'file',
      new Blob([gunzipSync(Buffer.from(XLS_FIXTURE_GZIP_BASE64, 'base64'))], {
        type: 'application/vnd.ms-excel'
      }),
      'anonymous-candidates.xls'
    )
    form.append('mapping', JSON.stringify({ name: 'Emitente' }))

    const response = await fetch(`${url}/api/import/preview`, { method: 'POST', body: form })
    const body = await responseJson(response)

    assert.equal(response.status, 200)
    assert.equal(body.sheet_name, 'Types')
    assert.deepEqual(body.headers, ['Emitente', 'Taxa', 'Data'])
    assert.equal(body.summary.total_rows, 3)
    assert.equal(body.summary.valid_rows, 3)
  })
})

test('BIFF8 .xls with the exact candidate ID header uses the Beisen talent profile', async () => {
  await withApp(async (url) => {
    const form = new FormData()
    form.append(
      'file',
      new Blob([gunzipSync(Buffer.from(BEISEN_XLS_FIXTURE_GZIP_BASE64, 'base64'))], {
        type: 'application/vnd.ms-excel'
      }),
      'beisen-candidates.xls'
    )

    const response = await fetch(`${url}/api/import/preview`, { method: 'POST', body: form })
    const body = await responseJson(response)

    assert.equal(response.status, 200)
    assert.equal(body.profile, 'beisen_talent')
    assert.equal(body.mapping.source_record_id, '应聘者ID')
    assert.deepEqual(body.headers.slice(0, 2), ['应聘者ID', '姓名'])
    assert.equal(body.summary.candidate_records, 3)
    assert.equal(body.summary.valid_rows, 3)
  })
})

test('Beisen import maps 入职状态 and 入职日期 for an existing source ID', async () => {
  await withApp(async (url) => {
    const appWorkbook = new ExcelJS.Workbook()
    const sheet = appWorkbook.addWorksheet('北森人才')
    sheet.addRow(['应聘者ID', '申请ID', '姓名', '职位名称', '入职状态', '入职日期'])
    sheet.addRow(['beisen-existing-1', 'application-1', '北森候选人', '工程师', '已入职', '2026-08-20'])
    const bytes = Buffer.from(await appWorkbook.xlsx.writeBuffer())

    const seed = new FormData()
    seed.append('file', new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }), 'beisen-existing.xlsx')
    const preview = await responseJson(await fetch(`${url}/api/import/preview`, { method: 'POST', body: seed }))
    assert.equal(preview.summary.valid_rows, 1)
    const commit = await responseJson(await fetch(`${url}/api/import/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preview_token: preview.preview_token })
    }))
    assert.equal(commit.imported_rows, 1)

    const candidateList = await responseJson(await fetch(`${url}/api/candidates`))
    const candidate = candidateList.items.find((item) => item.name === '北森候选人')
    assert.ok(candidate)
    const detail = await responseJson(await fetch(`${url}/api/candidates/${candidate.id}?include_sensitive=true`))
    assert.equal(detail.hire_status, '已入职')
    assert.equal(detail.hire_date, '2026-08-20')

    const updateWorkbook = new ExcelJS.Workbook()
    const updateSheet = updateWorkbook.addWorksheet('北森人才')
    updateSheet.addRow(['应聘者ID', '申请ID', '姓名', '职位名称', '入职状态', '入职日期'])
    updateSheet.addRow(['beisen-existing-1', 'application-1', '北森候选人', '工程师', '待入职', ''])
    const updateForm = new FormData()
    updateForm.append('file', new Blob([Buffer.from(await updateWorkbook.xlsx.writeBuffer())], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }), 'beisen-existing-update.xlsx')
    const updatePreview = await responseJson(await fetch(`${url}/api/import/preview`, {
      method: 'POST',
      body: updateForm
    }))
    assert.equal(updatePreview.summary.valid_rows, 1)
    const updateCommit = await responseJson(await fetch(`${url}/api/import/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preview_token: updatePreview.preview_token })
    }))
    assert.equal(updateCommit.updated_rows, 1)

    const updatedDetail = await responseJson(await fetch(`${url}/api/candidates/${candidate.id}?include_sensitive=true`))
    assert.equal(updatedDetail.hire_status, '待入职')
    assert.equal(updatedDetail.hire_date, '2026-08-20', 'empty update date must not erase the existing date')
  })
})

test('general import hire aliases preserve values through export', async () => {
  await withApp(async (url) => {
    const form = new FormData()
    form.append('file', new Blob([
      'name,hire status,hire date\nGeneral Alias,待入职,2026/08/21\n'
    ], { type: 'text/csv' }), 'hire-aliases.csv')
    const preview = await responseJson(await fetch(`${url}/api/import/preview`, { method: 'POST', body: form }))
    assert.equal(preview.summary.valid_rows, 1)
    assert.equal(preview.rows[0].candidate.hire_status, '待入职')
    assert.equal(preview.rows[0].candidate.hire_date, '2026-08-21')
    const commit = await responseJson(await fetch(`${url}/api/import/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preview_token: preview.preview_token })
    }))
    assert.equal(commit.imported_rows, 1)
    const exported = await (await fetch(`${url}/api/candidates/export?format=csv`)).text()
    assert.match(exported, /待入职/)
    assert.match(exported, /2026-08-21/)
  })
})

test('a renamed non-BIFF file is rejected as an invalid .xls', async () => {
  await withApp(async (url) => {
    const form = new FormData()
    form.append('file', new Blob(['not an excel workbook']), 'renamed.xls')

    const response = await fetch(`${url}/api/import/preview`, { method: 'POST', body: form })
    const body = await responseJson(response)

    assert.equal(response.status, 422)
    assert.equal(body.error.code, 'request_error')
    assert.match(body.error.message, /不是有效的 Excel 97-2003/)
  })
})

test('a damaged OLE2 container with a valid signature is rejected with 422', async () => {
  await withApp(async (url) => {
    const damaged = Buffer.alloc(512)
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(damaged)
    const form = new FormData()
    form.append('file', new Blob([damaged], { type: 'application/vnd.ms-excel' }), 'damaged.xls')

    const response = await fetch(`${url}/api/import/preview`, { method: 'POST', body: form })
    const body = await responseJson(response)

    assert.equal(response.status, 422)
    assert.equal(body.error.code, 'request_error')
    assert.equal(typeof body.error.message, 'string')
    assert.ok(body.error.message.length > 0)
  })
})
