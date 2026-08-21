import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { readCandidateImportFile } from '../../server/import-file.js'
import { normalizeHireDate } from '../../server/validation.js'

const ROOT = resolve(import.meta.dirname, '../..')
const SOURCE_DIR = 'C:/Users/cboy/Desktop/应聘者数据-8b201f07-bb01-433b-a206-3244454ee67c'
const OUTPUT_DIR = join(ROOT, 'outputs/2026-08-21-hire-status-cleaned')
const RENDER_DIR = join(ROOT, '.tmp-hire-status-artifact/renders')
const LOADER_NODE_ROOT = 'C:/Users/cboy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node'
let artifactEntry = null
let prerequisiteSkip = false
try {
  await access(SOURCE_DIR)
  await access(join(LOADER_NODE_ROOT, 'node_modules'))
  artifactEntry = createRequire(join(LOADER_NODE_ROOT, 'artifact-test-loader.cjs')).resolve('@oai/artifact-tool')
} catch {
  prerequisiteSkip = 'real source workbooks or the loader-provided artifact runtime are unavailable'
}

const WORKBOOKS = [
  { source: '自定义excel-2026-08-21 09_59_021.xls', retained: 182, missingDate: 0 },
  { source: '自定义excel-2026-08-21 10_00_002.xls', retained: 193, missingDate: 0 },
  { source: '自定义excel-2026-08-21 10_00_593.xls', retained: 243, missingDate: 1 },
  { source: '自定义excel-2026-08-21 10_01_574.xls', retained: 111, missingDate: 1 },
  { source: '自定义excel-2026-08-21 10_02_565.xls', retained: 180, missingDate: 0 },
  { source: '自定义excel-2026-08-21 10_03_576.xls', retained: 407, missingDate: 1 },
  { source: '自定义excel-2026-08-21 10_04_067.xls', retained: 74, missingDate: 1 }
]

const HEADERS = ['入职状态', '入职日期', '应聘者ID']

function outputName(source) {
  return `${source.slice(0, -'.xls'.length)}_已整理.xlsx`
}

function isRetained(row) {
  const status = String(row.values['入职状态'] ?? '').trim()
  return status !== '' && status !== '空'
}

function serialToIso(serial) {
  assert.equal(typeof serial, 'number')
  assert.ok(Number.isFinite(serial) && serial >= 0)
  const date = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000)
  assert.ok(!Number.isNaN(date.getTime()))
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
    .join('-')
}

async function sourceRows(spec) {
  const path = join(SOURCE_DIR, spec.source)
  const fileStats = await stat(path)
  const parsed = await readCandidateImportFile({
    path,
    originalname: spec.source,
    mimetype: 'application/vnd.ms-excel',
    size: fileStats.size
  })
  return parsed.rows.filter(isRetained).map((row) => ({
    status: String(row.values['入职状态'] ?? ''),
    date: normalizeHireDate(row.values['入职日期']),
    id: String(row.values['应聘者ID'] ?? '')
  }))
}

test('cleaned workbooks contain only non-empty hire statuses and preserve row alignment', {
  skip: prerequisiteSkip
}, async () => {
  const { FileBlob, SpreadsheetFile } = await import(pathToFileURL(artifactEntry).href)
  const outputFiles = (await readdir(OUTPUT_DIR)).filter((name) => name.endsWith('.xlsx')).sort()
  assert.equal(outputFiles.length, WORKBOOKS.length, 'exactly seven cleaned workbooks are required')
  const summary = JSON.parse(await readFile(join(OUTPUT_DIR, 'cleanup-summary.json'), 'utf8'))
  assert.equal(summary.filter_rule, "trim(status) !== '' && trim(status) !== '空'")
  assert.deepEqual(summary.headers, HEADERS)
  assert.deepEqual(summary.totals, {
    source_rows: 62_861,
    retained_rows: 1_390,
    removed_rows: 61_471,
    missing_date_rows: 4
  })
  assert.equal(summary.files.length, WORKBOOKS.length)

  for (const spec of WORKBOOKS) {
    const outputPath = join(OUTPUT_DIR, outputName(spec.source))
    await access(outputPath)
    const expectedRows = await sourceRows(spec)
    assert.equal(expectedRows.length, spec.retained)
    const fileSummary = summary.files.find((item) => item.source_file === spec.source)
    assert.ok(fileSummary)
    assert.equal(fileSummary.retained_rows, spec.retained)
    assert.equal(fileSummary.missing_date_rows, spec.missingDate)
    assert.equal(fileSummary.source_unchanged, true)
    assert.equal(fileSummary.source_sha256_before, fileSummary.source_sha256_after)
    assert.equal(fileSummary.formula_error_count, 0)

    const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath))
    assert.equal(workbook.worksheets.items.length, 1)
    const sheet = workbook.worksheets.getItemAt(0)
    const used = sheet.getUsedRange()
    const values = used.values
    assert.deepEqual(values[0], HEADERS)
    assert.equal(values.length - 1, spec.retained)
    assert.equal(sheet.getRange(`B2:B${values.length}`).format.numberFormat, 'yyyy-mm-dd')

    let missingDate = 0
    for (let index = 1; index < values.length; index += 1) {
      const [status, date, id] = values[index]
      const expected = expectedRows[index - 1]
      assert.equal(String(status ?? ''), expected.status)
      assert.notEqual(String(status ?? '').trim(), '')
      assert.notEqual(String(status ?? '').trim(), '空')
      assert.equal(String(id ?? ''), expected.id)
      if (expected.date == null) {
        missingDate += 1
        assert.ok(date == null || date === '')
      } else {
        assert.equal(serialToIso(date), expected.date)
      }
    }
    assert.equal(missingDate, spec.missingDate)

    const formulaErrors = await workbook.inspect({
      kind: 'match',
      searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
      options: { useRegex: true, maxResults: 300 },
      summary: `formula error scan: ${spec.source}`
    })
    assert.match(formulaErrors.ndjson, /matched 0 entries/)
    await access(join(RENDER_DIR, `${outputName(spec.source).slice(0, -'.xlsx'.length)}.png`))
  }
})
