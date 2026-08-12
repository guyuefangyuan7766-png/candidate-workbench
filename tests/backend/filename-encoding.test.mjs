import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { createApp } from '../../server/app.js'

const TERMINAL_IMPORT_STATUSES = new Set(['preview_ready', 'completed', 'failed', 'cancelled', 'timed_out'])

async function responseJson(response) {
  const payload = await response.json()
  assert.equal(response.ok, true, `${response.status} ${JSON.stringify(payload)}`)
  return payload
}

async function withApp(run) {
  const app = createApp({ databasePath: ':memory:', attachmentSuggestionProvider: null })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    await run(app, `http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await app.closeDatabase()
  }
}

async function importPreview(url, bytes, filename, mimeType, requestId) {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mimeType }), filename)
  form.append('client_request_id', requestId)
  const accepted = await responseJson(await fetch(`${url}/api/candidates/import/preview`, {
    method: 'POST',
    body: form
  }))
  let task = accepted
  for (let attempt = 0; attempt < 200 && !TERMINAL_IMPORT_STATUSES.has(task.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    task = await responseJson(await fetch(`${url}/api/candidates/import/tasks/${encodeURIComponent(task.task_id)}`))
  }
  assert.equal(task.status, 'preview_ready', JSON.stringify(task))
  return task
}

async function attachmentBatch(url, files, token) {
  const form = new FormData()
  for (const file of files) form.append('files', new Blob([file.bytes], { type: file.mimeType }), file.filename)
  const created = await responseJson(await fetch(`${url}/api/attachment-batches`, {
    method: 'POST',
    headers: { 'X-Attachment-Batch-Token': token },
    body: form
  }))
  let batch = created
  for (let attempt = 0; attempt < 300 && ['queued', 'processing'].includes(batch.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    batch = await responseJson(await fetch(`${url}/api/attachment-batches/${encodeURIComponent(batch.batch_id)}`, {
      headers: { 'X-Attachment-Batch-Token': token }
    }))
  }
  assert.equal(['queued', 'processing'].includes(batch.status), false, JSON.stringify(batch))
  return batch
}

function mojibake(value) {
  return Buffer.from(value, 'utf8').toString('latin1')
}

function replaceZipFilenameBytes(buffer, before, replacement) {
  assert.equal(Buffer.byteLength(before, 'ascii'), replacement.length)
  const result = Buffer.from(buffer)
  const needle = Buffer.from(before, 'ascii')
  let cursor = 0
  let replacements = 0
  while ((cursor = result.indexOf(needle, cursor)) >= 0) {
    replacement.copy(result, cursor)
    cursor += replacement.length
    replacements += 1
  }
  assert.equal(replacements, 2)
  return result
}

test('candidate import preserves Unicode filenames, worksheet names, headers, and values across task reads', async () => {
  await withApp(async (app, url) => {
    const csvFilename = '中文候选人 (最终版).csv'
    const csv = Buffer.from('姓名,手机号,邮箱\n测试候选人,13800000000,test@example.test\n', 'utf8')
    const csvTask = await importPreview(url, csv, csvFilename, 'text/csv', 'unicode-csv-preview')
    assert.equal(csvTask.result.filename, csvFilename)
    assert.deepEqual(csvTask.result.headers, ['姓名', '手机号', '邮箱'])
    assert.equal(csvTask.result.rows[0].candidate.name, '测试候选人')
    assert.equal(
      app.locals.db.prepare('SELECT file_name FROM candidate_import_tasks WHERE id = ?').get(csvTask.task_id).file_name,
      csvFilename
    )

    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('候选人资料')
    sheet.addRow(['姓名', '手机号', '邮箱', '自我评价'])
    sheet.addRow(['表格候选人', '13900000000', 'sheet@example.test', '中文字段值保持完整'])
    const xlsxFilename = 'Résumé 候选人 📄.xlsx'
    const xlsxTask = await importPreview(
      url,
      Buffer.from(await workbook.xlsx.writeBuffer()),
      xlsxFilename,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'unicode-xlsx-preview'
    )
    assert.equal(xlsxTask.result.filename, xlsxFilename)
    assert.equal(xlsxTask.result.sheet_name, '候选人资料')
    assert.deepEqual(xlsxTask.result.headers, ['姓名', '手机号', '邮箱', '自我评价'])
    assert.equal(xlsxTask.result.rows[0].candidate.name, '表格候选人')
    assert.equal(xlsxTask.result.rows[0].candidate.self_summary, '中文字段值保持完整')

    const storedResult = JSON.parse(app.locals.db.prepare(
      'SELECT result_json FROM candidate_import_tasks WHERE id = ?'
    ).get(csvTask.task_id).result_json)
    storedResult.filename = mojibake(csvFilename)
    app.locals.db.prepare(`
      UPDATE candidate_import_tasks SET file_name = ?, result_json = ? WHERE id = ?
    `).run(mojibake(csvFilename), JSON.stringify(storedResult), csvTask.task_id)
    const historical = await responseJson(await fetch(
      `${url}/api/candidates/import/tasks/${encodeURIComponent(csvTask.task_id)}`
    ))
    assert.equal(historical.file_name, csvFilename)
    assert.equal(historical.result.filename, csvFilename)
    assert.equal(
      app.locals.db.prepare('SELECT file_name FROM candidate_import_tasks WHERE id = ?').get(csvTask.task_id).file_name,
      mojibake(csvFilename),
      'display recovery must not rewrite historical rows'
    )
  })
})

test('attachment batches preserve Unicode directory names and recover historical display values without rewriting', async () => {
  await withApp(async (app, url) => {
    const chineseFilename = '目录/中文候选人 (最终版).csv'
    const unicodeFilename = '目录/Résumé 📄.csv'
    const batch = await attachmentBatch(url, [
      {
        filename: chineseFilename,
        mimeType: 'text/csv',
        bytes: Buffer.from('姓名,手机号,邮箱\n附件候选人,13700000000,attachment@example.test\n', 'utf8')
      },
      {
        filename: unicodeFilename,
        mimeType: 'text/csv',
        bytes: Buffer.from('姓名,手机号,邮箱\nUnicode Candidate,13600000000,unicode@example.test\n', 'utf8')
      }
    ], 'unicode-attachment-token-0001')
    assert.equal(batch.status, 'awaiting_confirmation')
    assert.deepEqual(
      batch.items.map((item) => item.archive_path).sort(),
      [chineseFilename, unicodeFilename].sort()
    )
    assert.deepEqual(
      batch.items.map((item) => item.original_filename).sort(),
      ['中文候选人 (最终版).csv', 'Résumé 📄.csv'].sort()
    )
    const chineseItem = batch.items.find((item) => item.archive_path === chineseFilename)
    assert.equal(chineseItem.preview.records[0].suggestions.find((item) => item.field === 'name').value, '附件候选人')

    app.locals.db.prepare(`
      UPDATE attachment_import_items SET original_filename = ?, archive_path = ? WHERE id = ?
    `).run(mojibake('中文候选人 (最终版).csv'), mojibake(chineseFilename), chineseItem.item_id)
    const recovered = await responseJson(await fetch(`${url}/api/attachment-batches/${batch.batch_id}`, {
      headers: { 'X-Attachment-Batch-Token': 'unicode-attachment-token-0001' }
    }))
    const recoveredItem = recovered.items.find((item) => item.item_id === chineseItem.item_id)
    assert.equal(recoveredItem.original_filename, '中文候选人 (最终版).csv')
    assert.equal(recoveredItem.archive_path, chineseFilename)
    assert.equal(
      app.locals.db.prepare('SELECT original_filename FROM attachment_import_items WHERE id = ?').get(chineseItem.item_id).original_filename,
      mojibake('中文候选人 (最终版).csv')
    )
  })
})

test('attachment ZIP import preserves UTF-8 Chinese names and decodes standards-compliant CP437 names', async () => {
  await withApp(async (_app, url) => {
    const archive = new JSZip()
    archive.file('压缩包/候选人 简历.csv', '姓名,手机号,邮箱\n压缩包候选人,13500000000,zip@example.test\n')
    const utf8Zip = Buffer.from(await archive.generateAsync({ type: 'nodebuffer', compression: 'STORE' }))
    const utf8Batch = await attachmentBatch(url, [{
      filename: '中文资料.zip',
      mimeType: 'application/zip',
      bytes: utf8Zip
    }], 'unicode-zip-token-0000001')
    const utf8Entry = utf8Batch.items.find((item) => item.kind === 'archive_entry')
    assert.equal(utf8Entry.original_filename, '候选人 简历.csv')
    assert.equal(utf8Entry.archive_path, '压缩包/候选人 简历.csv')
    assert.equal(utf8Entry.preview.records[0].suggestions.find((item) => item.field === 'name').value, '压缩包候选人')

    const legacy = new JSZip()
    legacy.file('resume.csv', 'name,email\nLegacy CP437,cp437@example.test\n')
    const legacyZip = Buffer.from(await legacy.generateAsync({ type: 'nodebuffer', compression: 'STORE' }))
    const cp437Name = Buffer.from([0x72, 0x82, 0x73, 0x75, 0x6d, 0x82, 0x2e, 0x63, 0x73, 0x76])
    const cp437Zip = replaceZipFilenameBytes(legacyZip, 'resume.csv', cp437Name)
    const cp437Batch = await attachmentBatch(url, [{
      filename: 'legacy.zip',
      mimeType: 'application/zip',
      bytes: cp437Zip
    }], 'cp437-zip-token-00000001')
    assert.equal(
      cp437Batch.items.find((item) => item.kind === 'archive_entry').original_filename,
      'résumé.csv'
    )
  })
})
