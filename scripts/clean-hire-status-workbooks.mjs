import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readCandidateImportFile } from '../server/import-file.js'
import { normalizeHireDate } from '../server/validation.js'
import {
  WORKBOOK_CONFIG_HELP,
  resolveWorkbookConfig
} from './hire-status-workbook-config.mjs'

const CONFIG = resolveWorkbookConfig()
const SOURCE_DIR = CONFIG.sourceDir
const OUTPUT_DIR = CONFIG.outputDir
const WORK_DIR = CONFIG.workDir
const RENDER_DIR = join(WORK_DIR, 'renders')
const EXPORT_STAGE_DIR = join(WORK_DIR, 'exports')
const LOADER_NODE_MODULES = CONFIG.loaderNodeModules
const ARTIFACT_LINK = join(WORK_DIR, 'node_modules')
const HEADERS = ['入职状态', '入职日期', '应聘者ID']
const SHEET_NAME = '应聘者申请数据'
const SOURCE_FILES = [
  '自定义excel-2026-08-21 09_59_021.xls',
  '自定义excel-2026-08-21 10_00_002.xls',
  '自定义excel-2026-08-21 10_00_593.xls',
  '自定义excel-2026-08-21 10_01_574.xls',
  '自定义excel-2026-08-21 10_02_565.xls',
  '自定义excel-2026-08-21 10_03_576.xls',
  '自定义excel-2026-08-21 10_04_067.xls'
]

const EXPECTED_OUTPUT_FILES = new Set(SOURCE_FILES.map(outputFilename))

async function ensureArtifactToolLink() {
  await mkdir(WORK_DIR, { recursive: true })
  let linkStats
  try {
    linkStats = await lstat(ARTIFACT_LINK)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!linkStats) await symlink(LOADER_NODE_MODULES, ARTIFACT_LINK, 'junction')
  const [actual, expected] = await Promise.all([realpath(ARTIFACT_LINK), realpath(LOADER_NODE_MODULES)])
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Artifact dependency junction points to an unexpected directory: ${actual}`)
  }
}

async function loadArtifactTool() {
  await ensureArtifactToolLink()
  const require = createRequire(join(WORK_DIR, 'artifact-loader.cjs'))
  const entry = require.resolve('@oai/artifact-tool')
  return {
    entry,
    module: await import(pathToFileURL(entry).href)
  }
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function outputFilename(sourceFilename) {
  return `${sourceFilename.slice(0, -'.xls'.length)}_已整理.xlsx`
}

async function assertOutputDirectoryContainsNoUnexpectedXlsx({ requireComplete = false } = {}) {
  const entries = await readdir(OUTPUT_DIR, { withFileTypes: true })
  const xlsxEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith('.xlsx'))
  const unexpected = xlsxEntries
    .map((entry) => entry.name)
    .filter((name) => !EXPECTED_OUTPUT_FILES.has(name))
  if (unexpected.length > 0) {
    throw new Error(
      `Output directory contains unexpected .xlsx file(s): ${unexpected.join(', ')}. ` +
      'Remove them or choose a dedicated output directory before rerunning.'
    )
  }
  const invalidExpected = xlsxEntries
    .filter((entry) => EXPECTED_OUTPUT_FILES.has(entry.name) && !entry.isFile())
    .map((entry) => entry.name)
  if (invalidExpected.length > 0) {
    throw new Error(
      `Expected output .xlsx path(s) must be ordinary files, not links or directories: ${invalidExpected.join(', ')}`
    )
  }
  if (requireComplete) {
    const xlsxFiles = xlsxEntries.map((entry) => entry.name)
    const present = new Set(xlsxFiles)
    const missing = [...EXPECTED_OUTPUT_FILES].filter((name) => !present.has(name))
    if (missing.length > 0 || xlsxFiles.length !== EXPECTED_OUTPUT_FILES.size) {
      throw new Error(`Output directory must contain exactly seven cleaned .xlsx files; missing: ${missing.join(', ')}`)
    }
  }
}

function sameFileIdentity(leftStats, rightStats) {
  return leftStats?.dev !== undefined && rightStats?.dev !== undefined &&
    leftStats?.ino !== undefined && rightStats?.ino !== undefined &&
    leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino
}

function expectedWritePaths() {
  const workbookPaths = SOURCE_FILES.flatMap((sourceFilename) => {
    const outputFile = outputFilename(sourceFilename)
    const previewFile = renderFilename(sourceFilename)
    const stagedOutputPath = join(EXPORT_STAGE_DIR, outputFile)
    return [
      join(OUTPUT_DIR, outputFile),
      stagedOutputPath,
      `${stagedOutputPath}.inspect.ndjson`,
      join(RENDER_DIR, previewFile)
    ]
  })
  return [...workbookPaths, join(OUTPUT_DIR, 'cleanup-summary.json')]
}

async function assertWritePathsDoNotAliasSources(outputPaths = expectedWritePaths()) {
  const sourceStats = await Promise.all(SOURCE_FILES.map(async (sourceFilename) => ({
    sourceFilename,
    sourcePath: join(SOURCE_DIR, sourceFilename),
    stats: await stat(join(SOURCE_DIR, sourceFilename))
  })))

  for (const outputPath of outputPaths) {
    let outputStats
    try {
      outputStats = await stat(outputPath)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    const alias = sourceStats.find(({ stats }) => sameFileIdentity(outputStats, stats))
    if (alias) {
      throw new Error(
        `Output path ${outputPath} aliases source workbook ${alias.sourcePath} by the same file identity; refusing to write.`
      )
    }
  }
}

function renderFilename(sourceFilename) {
  return `${sourceFilename.slice(0, -'.xls'.length)}_已整理.png`
}

function shouldRetain(row) {
  const status = String(row.values['入职状态'] ?? '').trim()
  return status !== '' && status !== '空'
}

function normalizeDate(value, sourceFilename, rowNumber) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const normalized = normalizeHireDate(raw)
  if (!normalized) {
    throw new Error(`${sourceFilename} row ${rowNumber} has an invalid hire date: ${raw}`)
  }
  return normalized
}

function sourceRecord(row, sourceFilename) {
  const status = String(row.values['入职状态'] ?? '')
  const hireDate = normalizeDate(row.values['入职日期'], sourceFilename, row.row_number)
  const candidateId = String(row.values['应聘者ID'] ?? '')
  return {
    status,
    hireDate,
    candidateId,
    values: [
      status,
      hireDate ? new Date(`${hireDate}T00:00:00.000Z`) : null,
      candidateId
    ]
  }
}

function styleSheet(sheet, rowCount) {
  const used = sheet.getRange(`A1:C${rowCount}`)
  used.format.font = { name: 'Microsoft YaHei', size: 10, color: '#172033' }
  used.format.rowHeight = 20
  used.format.borders = {
    insideHorizontal: { style: 'thin', color: '#E2E8F0' }
  }

  const header = sheet.getRange('A1:C1')
  header.format = {
    fill: '#1F4E78',
    font: { name: 'Microsoft YaHei', size: 10, bold: true, color: '#FFFFFF' },
    rowHeight: 26,
    verticalAlignment: 'center'
  }
  sheet.getRange(`A1:A${rowCount}`).format.columnWidth = 16
  sheet.getRange(`B1:B${rowCount}`).format.columnWidth = 14
  sheet.getRange(`C1:C${rowCount}`).format.columnWidth = 18
  if (rowCount > 1) {
    sheet.getRange(`A2:A${rowCount}`).format.numberFormat = '@'
    sheet.getRange(`B2:B${rowCount}`).format.numberFormat = 'yyyy-mm-dd'
    sheet.getRange(`C2:C${rowCount}`).format.numberFormat = '@'
    sheet.getRange(`B2:C${rowCount}`).format.horizontalAlignment = 'center'
  }
  sheet.freezePanes.freezeRows(1)
  sheet.showGridLines = false
}

async function buildWorkbook(artifact, parsed, sourceFilename) {
  const records = parsed.rows.filter(shouldRetain).map((row) => sourceRecord(row, sourceFilename))
  const workbook = artifact.Workbook.create()
  const sheet = workbook.worksheets.add(SHEET_NAME)
  const matrix = [HEADERS, ...records.map((record) => record.values)]
  sheet.getRangeByIndexes(0, 0, matrix.length, HEADERS.length).values = matrix
  styleSheet(sheet, matrix.length)
  return { workbook, sheet, records, matrix }
}

async function processWorkbook(artifact, sourceFilename) {
  const sourcePath = join(SOURCE_DIR, sourceFilename)
  const sourceStatsBefore = await stat(sourcePath)
  const sourceHashBefore = await sha256(sourcePath)
  const parsed = await readCandidateImportFile({
    path: sourcePath,
    originalname: sourceFilename,
    mimetype: 'application/vnd.ms-excel',
    size: sourceStatsBefore.size
  })
  if (parsed.headers.length !== HEADERS.length || !HEADERS.every((header, index) => parsed.headers[index] === header)) {
    throw new Error(`${sourceFilename} has unexpected headers: ${JSON.stringify(parsed.headers)}`)
  }

  const { workbook, records, matrix } = await buildWorkbook(artifact, parsed, sourceFilename)
  const retainedRows = records.length
  const missingDateRows = records.filter((record) => record.hireDate == null).length
  const outputFile = outputFilename(sourceFilename)
  const outputPath = join(OUTPUT_DIR, outputFile)
  const stagedOutputPath = join(EXPORT_STAGE_DIR, outputFile)
  const stagedInspectPath = `${stagedOutputPath}.inspect.ndjson`
  const previewFile = renderFilename(sourceFilename)
  const previewPath = join(RENDER_DIR, previewFile)
  const checkRange = `${SHEET_NAME}!A1:C${Math.min(matrix.length, 12)}`

  const inspection = await workbook.inspect({
    kind: 'table',
    range: checkRange,
    include: 'values,formulas',
    tableMaxRows: 12,
    tableMaxCols: 3,
    maxChars: 6_000
  })
  console.log(JSON.stringify({ event: 'inspect', source_file: sourceFilename, range: checkRange, ndjson: inspection.ndjson }))

  const formulaErrors = await workbook.inspect({
    kind: 'match',
    searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
    options: { useRegex: true, maxResults: 300 },
    summary: `final formula error scan: ${sourceFilename}`
  })
  if (!formulaErrors.ndjson.includes('matched 0 entries')) {
    throw new Error(`${sourceFilename} contains a formula error: ${formulaErrors.ndjson}`)
  }
  console.log(JSON.stringify({ event: 'formula_error_scan', source_file: sourceFilename, ndjson: formulaErrors.ndjson }))

  const renderRange = `A1:C${Math.min(matrix.length, 25)}`
  const preview = await workbook.render({
    sheetName: SHEET_NAME,
    range: renderRange,
    scale: 1.5,
    format: 'png'
  })
  const previewBytes = new Uint8Array(await preview.arrayBuffer())
  await assertWritePathsDoNotAliasSources([
    outputPath,
    stagedOutputPath,
    stagedInspectPath,
    previewPath
  ])
  await writeFile(previewPath, previewBytes)
  console.log(JSON.stringify({
    event: 'render',
    source_file: sourceFilename,
    sheet_name: SHEET_NAME,
    range: renderRange,
    render_path: previewPath,
    render_bytes: previewBytes.byteLength
  }))

  await assertWritePathsDoNotAliasSources([
    outputPath,
    stagedOutputPath,
    stagedInspectPath,
    previewPath
  ])
  const output = await artifact.SpreadsheetFile.exportXlsx(workbook)
  await output.save(stagedOutputPath)
  await assertWritePathsDoNotAliasSources([
    outputPath,
    stagedOutputPath,
    stagedInspectPath,
    previewPath
  ])
  await copyFile(stagedOutputPath, outputPath)
  await Promise.all([
    rm(stagedOutputPath, { force: true }),
    rm(stagedInspectPath, { force: true })
  ])

  const [sourceStatsAfter, sourceHashAfter, outputStats, outputHash] = await Promise.all([
    stat(sourcePath),
    sha256(sourcePath),
    stat(outputPath),
    sha256(outputPath)
  ])
  const sourceUnchanged = sourceStatsBefore.size === sourceStatsAfter.size && sourceHashBefore === sourceHashAfter
  if (!sourceUnchanged) throw new Error(`Source workbook changed while processing: ${sourceFilename}`)

  const statusCounts = Object.fromEntries(
    [...records.reduce((counts, record) => {
      counts.set(record.status, (counts.get(record.status) ?? 0) + 1)
      return counts
    }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
  )

  return {
    source_file: sourceFilename,
    source_path: sourcePath,
    source_sheet: parsed.sheetName,
    source_rows: parsed.rows.length,
    retained_rows: retainedRows,
    removed_rows: parsed.rows.length - retainedRows,
    missing_date_rows: missingDateRows,
    status_counts: statusCounts,
    output_file: outputFile,
    output_path: outputPath,
    output_bytes: outputStats.size,
    output_sha256: outputHash,
    render_file: previewFile,
    render_path: previewPath,
    render_bytes: previewBytes.byteLength,
    inspect_range: checkRange,
    formula_error_count: 0,
    source_bytes: sourceStatsBefore.size,
    source_sha256_before: sourceHashBefore,
    source_sha256_after: sourceHashAfter,
    source_unchanged: sourceUnchanged
  }
}

async function main() {
  if (CONFIG.help) {
    console.log(WORKBOOK_CONFIG_HELP.trim())
    return
  }
  await Promise.all([
    mkdir(OUTPUT_DIR, { recursive: true }),
    mkdir(RENDER_DIR, { recursive: true }),
    mkdir(EXPORT_STAGE_DIR, { recursive: true })
  ])
  await assertOutputDirectoryContainsNoUnexpectedXlsx()
  await assertWritePathsDoNotAliasSources()
  await Promise.all(SOURCE_FILES.map((sourceFilename) => (
    rm(join(OUTPUT_DIR, `${outputFilename(sourceFilename)}.inspect.ndjson`), { force: true })
  )))
  const { entry, module: artifact } = await loadArtifactTool()
  const files = []
  for (const sourceFilename of SOURCE_FILES) {
    const result = await processWorkbook(artifact, sourceFilename)
    files.push(result)
    console.log(JSON.stringify({ event: 'export', ...result }))
  }
  await assertOutputDirectoryContainsNoUnexpectedXlsx({ requireComplete: true })

  const summary = {
    generated_at: new Date().toISOString(),
    source_directory: SOURCE_DIR,
    output_directory: OUTPUT_DIR,
    artifact_tool_entry: entry,
    filter_rule: "trim(status) !== '' && trim(status) !== '空'",
    headers: HEADERS,
    reproduction: {
      command: 'node scripts/clean-hire-status-workbooks.mjs',
      required_test_command:
        'HIRE_STATUS_WORKBOOKS_REQUIRED=1 node --test tests/backend/hire-status-workbooks.test.mjs',
      cli_options: [
        '--source-dir',
        '--output-dir',
        '--work-dir',
        '--loader-node-root',
        '--loader-node-modules'
      ],
      environment_variables: [
        'HIRE_STATUS_SOURCE_DIR',
        'HIRE_STATUS_OUTPUT_DIR',
        'HIRE_STATUS_WORK_DIR',
        'HIRE_STATUS_LOADER_NODE_ROOT',
        'HIRE_STATUS_LOADER_NODE_MODULES',
        'HIRE_STATUS_WORKBOOKS_REQUIRED'
      ]
    },
    totals: {
      source_rows: files.reduce((sum, file) => sum + file.source_rows, 0),
      retained_rows: files.reduce((sum, file) => sum + file.retained_rows, 0),
      removed_rows: files.reduce((sum, file) => sum + file.removed_rows, 0),
      missing_date_rows: files.reduce((sum, file) => sum + file.missing_date_rows, 0)
    },
    files
  }
  const summaryPath = join(OUTPUT_DIR, 'cleanup-summary.json')
  await assertWritePathsDoNotAliasSources([summaryPath])
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ event: 'summary', summary_path: summaryPath, ...summary.totals }))
}

await main()
