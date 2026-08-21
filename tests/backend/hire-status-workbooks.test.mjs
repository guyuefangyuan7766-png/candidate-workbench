import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  access,
  copyFile,
  link as createHardLink,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import {
  checkWorkbookPrerequisites,
  resolveWorkbookConfig
} from '../../scripts/hire-status-workbook-config.mjs'
import { readCandidateImportFile } from '../../server/import-file.js'
import { normalizeHireDate } from '../../server/validation.js'

const ROOT = resolve(import.meta.dirname, '../..')
const CONFIG = resolveWorkbookConfig({ argv: [], env: process.env })
const SOURCE_DIR = CONFIG.sourceDir
const OUTPUT_DIR = CONFIG.outputDir
const WORK_DIR = CONFIG.workDir
const RENDER_DIR = join(WORK_DIR, 'renders')
const LOADER_NODE_ROOT = CONFIG.loaderNodeRoot
const SCRIPT_PATH = join(ROOT, 'scripts/clean-hire-status-workbooks.mjs')
const CONFIG_PATH = join(ROOT, 'scripts/hire-status-workbook-config.mjs')
const REQUIRE_REAL_FIXTURES = /^(1|true|yes)$/i.test(process.env.HIRE_STATUS_WORKBOOKS_REQUIRED ?? '')
let artifactEntry = null
let prerequisiteSkip = false
const prerequisites = await checkWorkbookPrerequisites(CONFIG, { required: REQUIRE_REAL_FIXTURES })
if (prerequisites.available) artifactEntry = prerequisites.artifactEntry
else {
  prerequisiteSkip = prerequisites.skipReason
  console.warn(`[hire-status-workbooks] SKIP: ${prerequisiteSkip}`)
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

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

test('cleaner exposes overridable paths and rejects extra xlsx files', async () => {
  const script = `${await readFile(CONFIG_PATH, 'utf8')}\n${await readFile(SCRIPT_PATH, 'utf8')}`
  assert.match(script, /HIRE_STATUS_SOURCE_DIR/)
  assert.match(script, /HIRE_STATUS_OUTPUT_DIR/)
  assert.match(script, /HIRE_STATUS_WORK_DIR/)
  assert.match(script, /HIRE_STATUS_LOADER_NODE_ROOT/)
  assert.match(script, /--source-dir/)
  assert.match(script, /--output-dir/)
  assert.match(script, /--work-dir/)
  assert.match(script, /unexpected.*xlsx|extra.*xlsx/i)

  const fixtureRoot = await mkdtemp(join(tmpdir(), 'hire-status-workbook-boundary-'))
  try {
    const outputDir = join(fixtureRoot, 'outputs')
    const workDir = join(fixtureRoot, 'work')
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, 'unexpected.xlsx'), 'sentinel')
    const missingSource = join(fixtureRoot, 'missing-source')
    const runCleaner = (args, env) => spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env }
    })
    const envChild = runCleaner([], {
      HIRE_STATUS_SOURCE_DIR: missingSource,
      HIRE_STATUS_OUTPUT_DIR: outputDir,
      HIRE_STATUS_WORK_DIR: workDir,
      HIRE_STATUS_LOADER_NODE_ROOT: LOADER_NODE_ROOT
    })
    assert.notEqual(envChild.status, 0, `${envChild.stdout}\n${envChild.stderr}`)
    assert.match(`${envChild.stdout}\n${envChild.stderr}`, /unexpected.*xlsx|extra.*xlsx/i)

    const cliOutputDir = join(fixtureRoot, 'cli-outputs')
    const cliWorkDir = join(fixtureRoot, 'cli-work')
    await mkdir(cliOutputDir, { recursive: true })
    await writeFile(join(cliOutputDir, 'unexpected-cli.xlsx'), 'sentinel')
    const cliChild = runCleaner([
      '--source-dir', missingSource,
      '--output-dir', cliOutputDir,
      '--work-dir', cliWorkDir,
      '--loader-node-root', LOADER_NODE_ROOT
    ], {
      HIRE_STATUS_SOURCE_DIR: '',
      HIRE_STATUS_OUTPUT_DIR: '',
      HIRE_STATUS_WORK_DIR: '',
      HIRE_STATUS_LOADER_NODE_ROOT: ''
    })
    assert.notEqual(cliChild.status, 0, `${cliChild.stdout}\n${cliChild.stderr}`)
    assert.match(`${cliChild.stdout}\n${cliChild.stderr}`, /unexpected.*xlsx|extra.*xlsx/i)

    const nonFileOutputDir = join(fixtureRoot, 'non-file-outputs')
    const nonFileWorkDir = join(fixtureRoot, 'non-file-work')
    await mkdir(join(nonFileOutputDir, 'unexpected-directory.xlsx'), { recursive: true })
    const nonFileChild = runCleaner([], {
      HIRE_STATUS_SOURCE_DIR: missingSource,
      HIRE_STATUS_OUTPUT_DIR: nonFileOutputDir,
      HIRE_STATUS_WORK_DIR: nonFileWorkDir,
      HIRE_STATUS_LOADER_NODE_ROOT: LOADER_NODE_ROOT
    })
    assert.notEqual(nonFileChild.status, 0, `${nonFileChild.stdout}\n${nonFileChild.stderr}`)
    assert.match(`${nonFileChild.stdout}\n${nonFileChild.stderr}`, /unexpected-directory\.xlsx/i)

    const invalidExpectedOutputDir = join(fixtureRoot, 'invalid-expected-outputs')
    const invalidExpectedWorkDir = join(fixtureRoot, 'invalid-expected-work')
    const expectedOutputName = outputName(WORKBOOKS[0].source)
    await mkdir(join(invalidExpectedOutputDir, expectedOutputName), { recursive: true })
    const invalidExpectedChild = runCleaner([
      '--source-dir', missingSource,
      '--output-dir', invalidExpectedOutputDir,
      '--work-dir', invalidExpectedWorkDir,
      '--loader-node-root', LOADER_NODE_ROOT
    ], {
      HIRE_STATUS_SOURCE_DIR: '',
      HIRE_STATUS_OUTPUT_DIR: '',
      HIRE_STATUS_WORK_DIR: '',
      HIRE_STATUS_LOADER_NODE_ROOT: ''
    })
    assert.notEqual(invalidExpectedChild.status, 0, `${invalidExpectedChild.stdout}\n${invalidExpectedChild.stderr}`)
    assert.match(`${invalidExpectedChild.stdout}\n${invalidExpectedChild.stderr}`, /ordinary file|regular file/i)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('workbook prerequisites provide explicit skip and required-mode messages', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'hire-status-workbook-prerequisite-'))
  try {
    const missingConfig = resolveWorkbookConfig({
      argv: [],
      env: {
        HIRE_STATUS_SOURCE_DIR: join(fixtureRoot, 'missing-source'),
        HIRE_STATUS_LOADER_NODE_ROOT: join(fixtureRoot, 'missing-loader')
      }
    })
    const optional = await checkWorkbookPrerequisites(missingConfig, { required: false })
    assert.equal(optional.available, false)
    assert.match(optional.skipReason, /HIRE_STATUS_WORKBOOKS_REQUIRED=1/)
    await assert.rejects(
      () => checkWorkbookPrerequisites(missingConfig, { required: true }),
      /HIRE_STATUS_WORKBOOKS_REQUIRED=1/
    )
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

async function runHardLinkAliasScenario(t, targetKind) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'hire-status-workbook-hard-link-'))
  try {
    const fixtureSourceDir = join(fixtureRoot, 'source')
    const fixtureOutputDir = join(fixtureRoot, 'outputs')
    const fixtureWorkDir = join(fixtureRoot, 'work')
    await mkdir(fixtureSourceDir, { recursive: true })
    await mkdir(fixtureOutputDir, { recursive: true })
    for (const spec of WORKBOOKS) {
      await copyFile(join(SOURCE_DIR, spec.source), join(fixtureSourceDir, spec.source))
    }

    const sourceName = WORKBOOKS[0].source
    const sourcePath = join(fixtureSourceDir, sourceName)
    const expectedOutputPath = join(fixtureOutputDir, outputName(sourceName))
    const targetPath = {
      output: expectedOutputPath,
      stage: join(fixtureWorkDir, 'exports', outputName(sourceName)),
      stageInspect: join(fixtureWorkDir, 'exports', `${outputName(sourceName)}.inspect.ndjson`),
      render: join(fixtureWorkDir, 'renders', `${sourceName.slice(0, -'.xls'.length)}_已整理.png`),
      summary: join(fixtureOutputDir, 'cleanup-summary.json')
    }[targetKind]
    assert.ok(targetPath, `unknown hard-link target kind: ${targetKind}`)
    await mkdir(dirname(targetPath), { recursive: true })
    const beforeStats = await stat(sourcePath)
    const beforeHash = await sha256(sourcePath)
    try {
      await createHardLink(sourcePath, targetPath)
    } catch (error) {
      if (['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'EXDEV', 'EINVAL'].includes(error?.code)) {
        t.skip(`hard links are unavailable on this filesystem (${error.code})`)
        return
      }
      throw error
    }

    const child = spawnSync(process.execPath, [
      SCRIPT_PATH,
      '--source-dir', fixtureSourceDir,
      '--output-dir', fixtureOutputDir,
      '--work-dir', fixtureWorkDir,
      '--loader-node-root', LOADER_NODE_ROOT
    ], {
      encoding: 'utf8',
      env: { ...process.env, HIRE_STATUS_WORKBOOKS_REQUIRED: '1' }
    })
    const childOutput = `${child.stdout}\n${child.stderr}`
    assert.notEqual(child.status, 0, childOutput)
    assert.match(childOutput, /alias|same file|same-file/i)

    if (targetKind !== 'output') {
      await assert.rejects(() => access(expectedOutputPath), /ENOENT/)
    }
    const targetStats = await stat(targetPath)
    assert.equal(targetStats.dev, beforeStats.dev)
    assert.equal(targetStats.ino, beforeStats.ino)
    const afterStats = await stat(sourcePath)
    assert.equal(afterStats.size, beforeStats.size)
    assert.equal(afterStats.dev, beforeStats.dev)
    assert.equal(afterStats.ino, beforeStats.ino)
    assert.equal(await sha256(sourcePath), beforeHash)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
}

for (const [targetKind, targetLabel] of [
  ['output', 'an expected output'],
  ['stage', 'a staged export'],
  ['stageInspect', 'a staged export inspect sidecar'],
  ['render', 'a render preview'],
  ['summary', 'a cleanup summary']
]) {
  test(`cleaner rejects ${targetLabel} hard link before writing any source file`, {
    skip: prerequisiteSkip
  }, async (t) => {
    await runHardLinkAliasScenario(t, targetKind)
  })
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
  assert.match(summary.reproduction.command, /clean-hire-status-workbooks\.mjs/)
  assert.deepEqual(summary.reproduction.cli_options, [
    '--source-dir',
    '--output-dir',
    '--work-dir',
    '--loader-node-root',
    '--loader-node-modules'
  ])
  assert.ok(summary.reproduction.environment_variables.includes('HIRE_STATUS_WORKBOOKS_REQUIRED'))
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
    const sourcePath = join(SOURCE_DIR, spec.source)
    const sourceStats = await stat(sourcePath)
    const sourceDigest = await sha256(sourcePath)
    const fileSummary = summary.files.find((item) => item.source_file === spec.source)
    assert.ok(fileSummary)
    assert.equal(fileSummary.retained_rows, spec.retained)
    assert.equal(fileSummary.missing_date_rows, spec.missingDate)
    assert.equal(fileSummary.source_unchanged, true)
    assert.equal(fileSummary.source_bytes, sourceStats.size)
    assert.equal(fileSummary.source_sha256_before, sourceDigest)
    assert.equal(fileSummary.source_sha256_after, sourceDigest)
    assert.equal(fileSummary.source_sha256_before, fileSummary.source_sha256_after)
    assert.equal(fileSummary.formula_error_count, 0)
    assert.ok(fileSummary.render_bytes > 0)

    const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath))
    assert.equal(workbook.worksheets.items.length, 1)
    const sheet = workbook.worksheets.getItemAt(0)
    assert.equal(sheet.name, '应聘者申请数据')
    const used = sheet.getUsedRange()
    const values = used.values
    assert.deepEqual(values[0], HEADERS)
    assert.equal(values.length - 1, spec.retained)
    assert.equal(sheet.getRange(`B2:B${values.length}`).format.numberFormat, 'yyyy-mm-dd')
    const inspected = await workbook.inspect({
      kind: 'table',
      range: `应聘者申请数据!A1:C${Math.min(values.length, 12)}`,
      include: 'values,formulas',
      tableMaxRows: 12,
      tableMaxCols: 3
    })
    assert.match(inspected.ndjson, /"sheet":"应聘者申请数据"/)
    assert.match(inspected.ndjson, /入职状态.*入职日期.*应聘者ID/)

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
