import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import ExcelJS from 'exceljs'
import { createApp } from '../../server/app.js'

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

async function workbookBuffer(rows) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sheet1')
  sheet.addRow(Object.keys(rows[0]))
  for (const row of rows) sheet.addRow(Object.values(row))
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

async function preview(url, buffer) {
  const form = new FormData()
  form.append('file', new Blob([buffer]), 'anonymous.xlsx')
  const response = await fetch(`${url}/api/import/preview`, { method: 'POST', body: form })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

/**
 * The Beisen export names these columns 最近任职公司 / 最近任职职位. The original
 * alias list only knew 最近工作公司 / 最近工作职位, so both columns were ignored
 * and every candidate ended up with an empty current_company and current_title.
 */
test('Beisen 最近任职公司 and 最近任职职位 feed current_company and current_title', async () => {
  await withApp(async (url) => {
    const buffer = await workbookBuffer([
      {
        应聘者ID: 'anonymous-alias-1',
        姓名: '匿名候选人',
        最近任职公司: '示例科技有限公司',
        最近任职职位: '资深后端工程师'
      }
    ])
    const result = await preview(url, buffer)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    const row = result.body.rows[0]
    assert.equal(row.candidate.name, '匿名候选人')
    assert.equal(row.candidate.current_company, '示例科技有限公司')
    assert.equal(row.candidate.current_title, '资深后端工程师')
  })
})

test('the legacy 最近工作公司 alias still maps for older workbooks', async () => {
  await withApp(async (url) => {
    const buffer = await workbookBuffer([
      {
        应聘者ID: 'anonymous-alias-2',
        姓名: '匿名候选人',
        最近工作公司: '旧格式公司',
        最近工作职位: '旧格式职位'
      }
    ])
    const result = await preview(url, buffer)
    assert.equal(result.status, 200)
    const row = result.body.rows[0]
    assert.equal(row.candidate.current_company, '旧格式公司')
    assert.equal(row.candidate.current_title, '旧格式职位')
  })
})
