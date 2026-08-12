import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { readCandidateImportFile } from '../../server/import-file.js'

const cleanups = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()()
})

const CRC32_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC32_TABLE[index] = value >>> 0
}

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function zipBuffer(entries) {
  const localParts = []
  const centralParts = []
  let localOffset = 0

  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '')
    const centralMethod = entry.centralMethod ?? entry.method ?? 8
    const localMethod = entry.localMethod ?? centralMethod
    const compressed = centralMethod === 8 ? deflateRawSync(data) : Buffer.from(data)
    const centralName = Buffer.from(entry.centralName ?? entry.name, 'utf8')
    const localName = Buffer.from(entry.localName ?? entry.name, 'utf8')
    const centralFlags = entry.centralFlags ?? entry.flags ?? 0x0800
    const localFlags = entry.localFlags ?? centralFlags
    const declaredSize = entry.declaredSize ?? data.length
    const declaredCrc = entry.declaredCrc ?? crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(entry.localVersionNeeded ?? 20, 4)
    local.writeUInt16LE(localFlags, 6)
    local.writeUInt16LE(localMethod, 8)
    local.writeUInt32LE(entry.localCrc ?? declaredCrc, 14)
    local.writeUInt32LE(entry.localCompressedSize ?? compressed.length, 18)
    local.writeUInt32LE(entry.localUncompressedSize ?? declaredSize, 22)
    local.writeUInt16LE(localName.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, localName, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(entry.centralVersionNeeded ?? 20, 6)
    central.writeUInt16LE(centralFlags, 8)
    central.writeUInt16LE(centralMethod, 10)
    central.writeUInt32LE(declaredCrc, 16)
    central.writeUInt32LE(entry.centralCompressedSize ?? compressed.length, 20)
    central.writeUInt32LE(declaredSize, 24)
    central.writeUInt16LE(centralName.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(entry.localOffset ?? localOffset, 42)
    centralParts.push(central, centralName)

    localOffset += local.length + localName.length + compressed.length
  }

  const locals = Buffer.concat(localParts)
  const central = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(locals.length, 16)
  return Buffer.concat([locals, central, eocd])
}

function workbookEntries(overrides = []) {
  return [
    { name: '[Content_Types].xml', data: '<Types />' },
    { name: 'xl/workbook.xml', data: '<workbook />' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet />' },
    ...overrides
  ]
}

function temporaryImport(name, content, mimetype) {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-import-security-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, name)
  writeFileSync(path, content)
  return { path, originalname: name, mimetype }
}

function xlsxFile(entries) {
  return temporaryImport(
    'anonymous.xlsx',
    zipBuffer(entries),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
}

async function rejectsWithCode(run, expectedCode) {
  await assert.rejects(run, (error) => {
    assert.equal(error?.status, 422)
    assert.equal(error?.code, expectedCode)
    return true
  })
}

test('candidate XLSX validation counts actual inflated bytes instead of trusting forged sizes', async () => {
  const entries = workbookEntries()
  entries[0] = { ...entries[0], data: 'A'.repeat(512), declaredSize: 1, localUncompressedSize: 1 }
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(entries)),
    'import_zip_size_mismatch'
  )

  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(entries), { maxEntryUncompressedBytes: 128 }),
    'import_uncompressed_limit_exceeded'
  )
})

test('candidate XLSX validation rejects central and local header mismatches', async () => {
  const entries = workbookEntries()
  entries[1] = { ...entries[1], localMethod: 0 }
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(entries)),
    'import_zip_header_mismatch'
  )
})

test('candidate XLSX validation rejects unsafe and duplicate canonical paths', async () => {
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(workbookEntries([{ name: '../escape.xml', data: 'unsafe' }]))),
    'import_zip_unsafe_path'
  )
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(workbookEntries([{ name: 'XL/WORKBOOK.XML', data: 'duplicate' }]))),
    'import_zip_duplicate_path'
  )
})

test('candidate XLSX validation verifies CRC32 and rejects unsupported ZIP features', async () => {
  const badCrcEntries = workbookEntries()
  badCrcEntries[2] = { ...badCrcEntries[2], declaredCrc: 0x12345678, localCrc: 0x12345678 }
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(badCrcEntries)),
    'import_zip_crc_mismatch'
  )

  const unsupportedEntries = workbookEntries()
  unsupportedEntries[2] = { ...unsupportedEntries[2], centralMethod: 99, localMethod: 99 }
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(unsupportedEntries)),
    'import_zip_compression_unsupported'
  )

  const encryptedEntries = workbookEntries()
  encryptedEntries[2] = { ...encryptedEntries[2], flags: 0x0801 }
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(encryptedEntries)),
    'import_encrypted'
  )

  const zip64Entries = workbookEntries()
  zip64Entries[2] = { ...zip64Entries[2], centralVersionNeeded: 45, localVersionNeeded: 45 }
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(zip64Entries)),
    'import_zip64_unsupported'
  )
})

test('candidate import Worker enforces a parent wall-clock timeout', async () => {
  const file = temporaryImport(
    'anonymous.csv',
    `name,notes\nAnonymous,"${'a'.repeat(150_000)}"`,
    'text/csv'
  )
  await rejectsWithCode(
    () => readCandidateImportFile(file, { maxParseMs: 1 }),
    'import_parse_timeout'
  )
})

test('streamed CSV parsing preserves quoted fields across chunks without quadratic concatenation', async () => {
  const longText = `${'a'.repeat(70_000)}\nwith,comma and ""quote""`
  const file = temporaryImport(
    'anonymous.csv',
    `name,notes\r\nAnonymous,"${longText}"\r\n`,
    'text/csv'
  )
  const parsed = await readCandidateImportFile(file)
  assert.equal(parsed.rows.length, 1)
  assert.equal(parsed.rows[0].values.notes, `${'a'.repeat(70_000)}\nwith,comma and "quote"`)
})

test('candidate import rejects NUL bytes in CSV instead of treating binary data as text', async () => {
  const file = temporaryImport(
    'anonymous.csv',
    Buffer.from('name,email\nAnonymous,anonymous@example.test\0hidden', 'utf8'),
    'text/csv'
  )
  await rejectsWithCode(
    () => readCandidateImportFile(file),
    'import_csv_binary'
  )
})
