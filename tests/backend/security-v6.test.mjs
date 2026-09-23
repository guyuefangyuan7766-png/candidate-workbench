import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { createApp } from '../../server/app.js'
import { parseAttachment, validateAttachmentFile } from '../../server/attachment-parser.js'

async function startAnonymousApp() {
  const app = createApp({ databasePath: ':memory:' })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  return {
    app,
    server,
    url: `http://127.0.0.1:${address.port}`
  }
}

async function closeAnonymousApp(fixture) {
  fixture.server.close()
  await once(fixture.server, 'close')
  fixture.app.closeDatabase()
}

test('cross-site writes are rejected before JSON or multipart processing and browser hardening headers are present', async (t) => {
  const fixture = await startAnonymousApp()
  t.after(() => closeAnonymousApp(fixture))

  const health = await fetch(`${fixture.url}/api/health`)
  assert.equal(health.status, 200)
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(health.headers.get('x-frame-options'), 'DENY')
  assert.match(health.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
  assert.equal(health.headers.get('referrer-policy'), 'no-referrer')
  const permissionsPolicy = (health.headers.get('permissions-policy') ?? '')
    .split(',')
    .map((directive) => directive.trim())
  for (const directive of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()']) {
    assert.ok(permissionsPolicy.includes(directive), `Permissions-Policy should include ${directive}`)
  }

  const blockedPreflight = await fetch(`${fixture.url}/api/candidates`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://attacker.invalid',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type'
    }
  })
  assert.equal(blockedPreflight.status, 403)
  assert.equal(blockedPreflight.headers.get('access-control-allow-origin'), null)

  const candidateResponse = await fetch(`${fixture.url}/api/candidates`, {
    method: 'POST',
    headers: {
      origin: 'https://attacker.invalid',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ name: '不应写入的候选人' })
  })
  assert.equal(candidateResponse.status, 403)
  assert.equal((await candidateResponse.json()).error.code, 'origin_not_allowed')

  const form = new FormData()
  form.append('file', new Blob(['name,email\nBlocked,blocked@example.invalid\n'], { type: 'text/csv' }), 'blocked.csv')
  const attachmentResponse = await fetch(`${fixture.url}/api/attachments/previews`, {
    method: 'POST',
    headers: { origin: 'https://attacker.invalid' },
    body: form
  })
  assert.equal(attachmentResponse.status, 403)
  assert.equal((await attachmentResponse.json()).error.code, 'origin_not_allowed')
  assert.equal(fixture.app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count, 0)
  assert.equal(fixture.app.locals.db.prepare('SELECT COUNT(*) AS count FROM attachment_update_previews').get().count, 0)

  const sameOriginResponse = await fetch(`${fixture.url}/api/candidates`, {
    method: 'POST',
    headers: {
      origin: fixture.url,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ name: '匿名候选人' })
  })
  assert.equal(sameOriginResponse.status, 201)

  const localClientResponse = await fetch(`${fixture.url}/api/candidates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Anonymous local client candidate' })
  })
  assert.equal(localClientResponse.status, 201)
  assert.equal((await localClientResponse.json()).name, 'Anonymous local client candidate')
})

function forgeDeclaredZipSize(buffer) {
  const forged = Buffer.from(buffer)
  let eocd = -1
  for (let offset = forged.length - 22; offset >= Math.max(0, forged.length - 65_557); offset -= 1) {
    if (forged.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  assert.notEqual(eocd, -1)
  const count = forged.readUInt16LE(eocd + 10)
  let cursor = forged.readUInt32LE(eocd + 16)
  for (let index = 0; index < count; index += 1) {
    assert.equal(forged.readUInt32LE(cursor), 0x02014b50)
    const declaredSize = forged.readUInt32LE(cursor + 24)
    if (declaredSize > 1) {
      const forgedSize = declaredSize - 1
      const localHeaderOffset = forged.readUInt32LE(cursor + 42)
      const flags = forged.readUInt16LE(cursor + 8)
      forged.writeUInt32LE(forgedSize, cursor + 24)
      if ((flags & 0x0008) === 0) forged.writeUInt32LE(forgedSize, localHeaderOffset + 22)
      return forged
    }
    cursor += 46 + forged.readUInt16LE(cursor + 28) + forged.readUInt16LE(cursor + 30) + forged.readUInt16LE(cursor + 32)
  }
  throw new Error('Fixture did not contain a non-empty ZIP entry')
}

test('Office parser verifies actual inflated bytes instead of trusting ZIP directory sizes', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('匿名简历')
  sheet.addRow(['姓名', '邮箱'])
  sheet.addRow(['匿名候选人', 'anonymous@example.invalid'])
  const forged = forgeDeclaredZipSize(await workbook.xlsx.writeBuffer())
  const file = {
    originalname: 'anonymous.xlsx',
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: forged
  }
  const validated = validateAttachmentFile(file)
  await assert.rejects(
    parseAttachment(file, validated),
    (error) => error?.code === 'zip_size_mismatch' && error?.status === 422
  )
})
