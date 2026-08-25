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

function prefixedSpreadsheetEntries() {
  return spreadsheetEntries()
}

const SPREADSHEETML_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const DOCUMENT_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships'
const WORKSHEET_RELATIONSHIP_TYPE = `${DOCUMENT_RELATIONSHIPS_NAMESPACE}/worksheet`

function anonymousWorksheetXml({ prefix = 'x', header = '匿名表头', value = '匿名值' } = {}) {
  return `<?xml version="1.0" encoding="utf-8"?><${prefix}:worksheet xmlns:${prefix}="${SPREADSHEETML_NAMESPACE}"><${prefix}:sheetData><${prefix}:row r="1"><${prefix}:c r="A1" t="str"><${prefix}:v>${header}</${prefix}:v></${prefix}:c></${prefix}:row><${prefix}:row r="2"><${prefix}:c r="A2" t="str"><${prefix}:v>${value}</${prefix}:v></${prefix}:c></${prefix}:row></${prefix}:sheetData></${prefix}:worksheet>`
}

function spreadsheetEntries({
  workbookPrefix = 'x',
  worksheetPrefix = workbookPrefix,
  workbookXml,
  relationshipsXml,
  worksheetXml,
  relationshipTarget = '/xl/worksheets/sheet1.xml',
  relationshipTargetMode,
  worksheetMethod
} = {}) {
  const workbookName = `${workbookPrefix}:workbook`
  const sheetsName = `${workbookPrefix}:sheets`
  const sheetName = `${workbookPrefix}:sheet`
  const worksheetName = `${worksheetPrefix}:worksheet`
  const sheetDataName = `${worksheetPrefix}:sheetData`
  const rowName = `${worksheetPrefix}:row`
  const cellName = `${worksheetPrefix}:c`
  const valueName = `${worksheetPrefix}:v`
  const targetMode = relationshipTargetMode ? ` TargetMode="${relationshipTargetMode}"` : ''

  return [
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/xl/workbook.xml" Id="RootWorkbook"/></Relationships>'
    },
    {
      name: 'xl/workbook.xml',
      data: workbookXml ?? `<?xml version="1.0" encoding="utf-8"?><${workbookName} xmlns:${workbookPrefix}="${SPREADSHEETML_NAMESPACE}" xmlns:r="${DOCUMENT_RELATIONSHIPS_NAMESPACE}"><${sheetsName}><${sheetName} name="应聘者申请数据" sheetId="1" r:id="SheetRelation"/></${sheetsName}></${workbookName}>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: relationshipsXml ?? `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="${PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Type="${WORKSHEET_RELATIONSHIP_TYPE}" Target="${relationshipTarget}" Id="SheetRelation"${targetMode}/></Relationships>`
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      method: worksheetMethod,
      data: worksheetXml ?? `<?xml version="1.0" encoding="utf-8"?><${worksheetName} xmlns:${worksheetPrefix}="${SPREADSHEETML_NAMESPACE}"><${sheetDataName}><${rowName} r="1"><${cellName} r="A1" t="str"><${valueName}>姓名</${valueName}></${cellName}><${cellName} r="B1" t="str"><${valueName}>应聘者ID</${valueName}></${cellName}><${cellName} r="C1" t="str"><${valueName}>入职职位</${valueName}></${cellName}></${rowName}><${rowName} r="2"><${cellName} r="A2" t="str"><${valueName}>匿名候选人</${valueName}></${cellName}><${cellName} r="B2" t="str"><${valueName}>anonymous-prefixed-1</${valueName}></${cellName}><${cellName} r="C2" t="str"><${valueName}>平台工程师</${valueName}></${cellName}></${rowName}></${sheetDataName}></${worksheetName}>`
    }
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

test('candidate XLSX import accepts namespace-prefixed SpreadsheetML elements', async () => {
  const parsed = await readCandidateImportFile(xlsxFile(prefixedSpreadsheetEntries()))

  assert.equal(parsed.sheetName, '应聘者申请数据')
  assert.deepEqual(parsed.headers, ['姓名', '应聘者ID', '入职职位'])
  assert.equal(parsed.rows.length, 1)
  assert.deepEqual(parsed.rows[0].values, {
    姓名: '匿名候选人',
    应聘者ID: 'anonymous-prefixed-1',
    入职职位: '平台工程师'
  })
})

test('candidate XLSX import resolves workbook and worksheet prefixes independently', async () => {
  const parsed = await readCandidateImportFile(xlsxFile(spreadsheetEntries({
    workbookPrefix: 'x',
    worksheetPrefix: 'y'
  })))

  assert.equal(parsed.sheetName, '应聘者申请数据')
  assert.equal(parsed.rows.length, 1)
})

test('candidate XLSX import rejects a worksheet prefix rebound to a non-SpreadsheetML namespace', async () => {
  const worksheetXml = `<?xml version="1.0" encoding="utf-8"?><y:worksheet xmlns:y="${SPREADSHEETML_NAMESPACE}"><y:sheetData><y:row xmlns:y="urn:not-spreadsheetml" r="1"><y:c r="A1" t="str"><y:v>姓名</y:v></y:c></y:row><y:row xmlns:y="urn:not-spreadsheetml" r="2"><y:c r="A2" t="str"><y:v>匿名候选人</y:v></y:c></y:row></y:sheetData></y:worksheet>`
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(spreadsheetEntries({ workbookPrefix: 'y', worksheetXml }))),
    'import_xlsx_invalid'
  )
})

test('candidate XLSX import ignores commented workbook sheet pseudo-elements', async () => {
  const workbookXml = `<?xml version="1.0" encoding="utf-8"?><x:workbook xmlns:x="${SPREADSHEETML_NAMESPACE}" xmlns:r="${DOCUMENT_RELATIONSHIPS_NAMESPACE}"><x:sheets><!-- <x:sheet name="注释伪工作表" sheetId="99" r:id="SheetRelation"/> --><x:sheet name="应聘者申请数据" sheetId="1" r:id="SheetRelation"/></x:sheets></x:workbook>`
  const parsed = await readCandidateImportFile(xlsxFile(spreadsheetEntries({ workbookXml })))

  assert.equal(parsed.sheetName, '应聘者申请数据')
})

test('candidate XLSX import rejects malformed workbook and relationship XML', async () => {
  const malformedWorkbook = `<?xml version="1.0" encoding="utf-8"?><x:workbook xmlns:x="${SPREADSHEETML_NAMESPACE}" xmlns:r="${DOCUMENT_RELATIONSHIPS_NAMESPACE}"><x:sheets><x:sheet name="应聘者申请数据" sheetId="1" r:id="SheetRelation"/></x:sheets>`
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(spreadsheetEntries({ workbookXml: malformedWorkbook }))),
    'import_xlsx_invalid'
  )

  const malformedRelationships = `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="${PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Type="${WORKSHEET_RELATIONSHIP_TYPE}" Target="worksheets/sheet1.xml" Id="SheetRelation"/>`
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(spreadsheetEntries({ relationshipsXml: malformedRelationships }))),
    'import_xlsx_invalid'
  )
})

test('candidate XLSX import validates workbook and relationship root namespaces', async () => {
  const wrongWorkbookNamespace = `<?xml version="1.0" encoding="utf-8"?><x:workbook xmlns:x="urn:not-spreadsheetml" xmlns:r="${DOCUMENT_RELATIONSHIPS_NAMESPACE}"><x:sheets><x:sheet name="应聘者申请数据" sheetId="1" r:id="SheetRelation"/></x:sheets></x:workbook>`
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(spreadsheetEntries({ workbookXml: wrongWorkbookNamespace }))),
    'import_xlsx_invalid'
  )

  const wrongRelationshipsNamespace = `<?xml version="1.0" encoding="utf-8"?><p:Relationships xmlns:p="urn:not-package-relationships"><Relationship Type="${WORKSHEET_RELATIONSHIP_TYPE}" Target="worksheets/sheet1.xml" Id="SheetRelation"/></p:Relationships>`
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(spreadsheetEntries({ relationshipsXml: wrongRelationshipsNamespace }))),
    'import_xlsx_invalid'
  )
})

test('candidate XLSX import requires sheet relationship attributes', async () => {
  const workbookWithoutRelationshipId = `<?xml version="1.0" encoding="utf-8"?><x:workbook xmlns:x="${SPREADSHEETML_NAMESPACE}" xmlns:r="${DOCUMENT_RELATIONSHIPS_NAMESPACE}"><x:sheets><x:sheet name="应聘者申请数据" sheetId="1"/></x:sheets></x:workbook>`
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(spreadsheetEntries({ workbookXml: workbookWithoutRelationshipId }))),
    'import_xlsx_invalid'
  )

  const workbookWithWrongRelationshipNamespace = `<?xml version="1.0" encoding="utf-8"?><x:workbook xmlns:x="${SPREADSHEETML_NAMESPACE}" xmlns:z="urn:not-document-relationships"><x:sheets><x:sheet name="应聘者申请数据" sheetId="1" z:id="SheetRelation"/></x:sheets></x:workbook>`
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(spreadsheetEntries({ workbookXml: workbookWithWrongRelationshipNamespace }))),
    'import_xlsx_invalid'
  )

  const relationshipWithoutTarget = `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="${PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Type="${WORKSHEET_RELATIONSHIP_TYPE}" Id="SheetRelation"/></Relationships>`
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(spreadsheetEntries({ relationshipsXml: relationshipWithoutTarget }))),
    'import_xlsx_invalid'
  )
})

test('candidate XLSX import resolves internal OPC relationship targets from the workbook part', async () => {
  const parsed = await readCandidateImportFile(xlsxFile(spreadsheetEntries({
    relationshipTarget: '/xl/worksheets/../worksheets/sheet1.xml',
    relationshipTargetMode: 'Internal'
  })))

  assert.equal(parsed.sheetName, '应聘者申请数据')
  assert.equal(parsed.rows.length, 1)
})

test('candidate XLSX import rejects external, ambiguous, and package-escaping relationship targets', async () => {
  const invalidTargets = [
    { relationshipTarget: 'https://example.test/sheet1.xml', relationshipTargetMode: 'External' },
    { relationshipTarget: '//example.test/xl/worksheets/sheet1.xml' },
    { relationshipTarget: 'worksheets/sheet1.xml?download=1' },
    { relationshipTarget: 'worksheets/sheet1.xml#fragment' },
    { relationshipTarget: '../../outside.xml' }
  ]

  for (const options of invalidTargets) {
    await rejectsWithCode(
      () => readCandidateImportFile(xlsxFile(spreadsheetEntries(options))),
      'import_xlsx_invalid'
    )
  }
})

test('candidate XLSX import normalizes a prefixed worksheet QName across parser chunks', async () => {
  const worksheetPrefix = `y${'a'.repeat(70_000)}`
  const parsed = await readCandidateImportFile(xlsxFile(spreadsheetEntries({
    workbookPrefix: 'x',
    worksheetPrefix,
    worksheetMethod: 0
  })))

  assert.equal(parsed.sheetName, '应聘者申请数据')
  assert.equal(parsed.rows.length, 1)
})

test('candidate XLSX import ignores an unreferenced worksheet that appears first in the ZIP', async () => {
  const entries = spreadsheetEntries({ relationshipTarget: 'worksheets/sheet2.xml' })
  entries[4] = {
    name: 'xl/worksheets/sheet1.xml',
    data: anonymousWorksheetXml({ header: '未引用表头', value: '未引用值' })
  }
  entries.push({
    name: 'xl/worksheets/sheet2.xml',
    data: anonymousWorksheetXml({ header: '引用表头', value: '引用值' })
  })

  const parsed = await readCandidateImportFile(xlsxFile(entries))

  assert.deepEqual(parsed.headers, ['引用表头'])
  assert.equal(parsed.rows.length, 1)
})

test('candidate XLSX import reads the exact non-default worksheet part named by the relationship', async () => {
  const entries = spreadsheetEntries({ relationshipTarget: 'worksheets/candidates.xml' })
  entries[4] = {
    name: 'xl/worksheets/sheet1.xml',
    data: anonymousWorksheetXml({ header: '未引用默认表头', value: '未引用默认值' })
  }
  entries.push({
    name: 'xl/worksheets/candidates.xml',
    data: anonymousWorksheetXml({ header: '自定义部件表头', value: '自定义部件值' })
  })

  const parsed = await readCandidateImportFile(xlsxFile(entries))

  assert.deepEqual(parsed.headers, ['自定义部件表头'])
  assert.equal(parsed.sheetName, '应聘者申请数据')
})

test('candidate XLSX import rejects a worksheet relationship whose exact target part is missing', async () => {
  const entries = spreadsheetEntries({ relationshipTarget: 'worksheets/missing.xml' })
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(entries)),
    'import_xlsx_invalid'
  )
})

test('candidate XLSX import rejects two worksheet relationships that normalize to one target', async () => {
  const workbookXml = `<?xml version="1.0" encoding="utf-8"?><x:workbook xmlns:x="${SPREADSHEETML_NAMESPACE}" xmlns:r="${DOCUMENT_RELATIONSHIPS_NAMESPACE}"><x:sheets><x:sheet name="匿名工作表一" sheetId="1" r:id="SheetRelation1"/><x:sheet name="匿名工作表二" sheetId="2" r:id="SheetRelation2"/></x:sheets></x:workbook>`
  const relationshipsXml = `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="${PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Type="${WORKSHEET_RELATIONSHIP_TYPE}" Target="worksheets/sheet1.xml" Id="SheetRelation1"/><Relationship Type="${WORKSHEET_RELATIONSHIP_TYPE}" Target="/xl/worksheets/./sheet1.xml" Id="SheetRelation2"/></Relationships>`
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(spreadsheetEntries({ workbookXml, relationshipsXml }))),
    'import_xlsx_invalid'
  )
})

test('candidate XLSX import does not approximate a missing worksheet target filename', async () => {
  const entries = spreadsheetEntries()
  entries[4] = {
    name: 'xl/worksheets/sheet1.xml.bak',
    data: anonymousWorksheetXml({ header: '近似文件表头', value: '近似文件值' })
  }
  entries.push({
    name: 'xl/worksheets/sheet10.xml',
    data: anonymousWorksheetXml({ header: '其他工作表头', value: '其他工作表值' })
  })

  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(entries)),
    'import_xlsx_invalid'
  )
})

test('candidate XLSX import rejects SpreadsheetML sheets smuggled through a foreign wrapper', async () => {
  const workbookXml = `<?xml version="1.0" encoding="utf-8"?><x:workbook xmlns:x="${SPREADSHEETML_NAMESPACE}" xmlns:r="${DOCUMENT_RELATIONSHIPS_NAMESPACE}" xmlns:f="urn:foreign"><f:wrapper><y:sheets xmlns:y="${SPREADSHEETML_NAMESPACE}"><y:sheet name="应聘者申请数据" sheetId="1" r:id="SheetRelation"/></y:sheets></f:wrapper></x:workbook>`
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(spreadsheetEntries({ workbookXml }))),
    'import_xlsx_invalid'
  )
})

test('candidate XLSX import rejects sheets smuggled through a locally rebound default namespace', async () => {
  const workbookXml = `<?xml version="1.0" encoding="utf-8"?><workbook xmlns="${SPREADSHEETML_NAMESPACE}" xmlns:r="${DOCUMENT_RELATIONSHIPS_NAMESPACE}"><wrapper xmlns="urn:foreign"><sheets xmlns="${SPREADSHEETML_NAMESPACE}"><sheet name="应聘者申请数据" sheetId="1" r:id="SheetRelation"/></sheets></wrapper></workbook>`
  await rejectsWithCode(
    () => readCandidateImportFile(xlsxFile(spreadsheetEntries({ workbookXml }))),
    'import_xlsx_invalid'
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
