// Temporary staging-only preparation helper. It never opens the production DB.
import { createHash } from 'node:crypto'
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { readXls } from 'xls-reader'
import { readCandidateImportFile } from '../server/import-file.js'
import { normalizeHireDate } from '../server/validation.js'

const [rootA, rootB, staging] = process.argv.slice(2)
if (!rootA || !rootB || !staging) throw new Error('usage: prepare <talent-root> <applicant-root> <staging>')

const TARGET_BYTES = 48 * 1024 * 1024
const SUPPORTED = new Set(['.xls', '.xlsx', '.xlsm', '.csv'])

function cellText(value) {
  if (value == null) return ''
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return ''
    const date = [value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()]
      .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0')).join('-')
    if (!value.getUTCHours() && !value.getUTCMinutes() && !value.getUTCSeconds() && !value.getUTCMilliseconds()) return date
    return value.toISOString()
  }
  if (typeof value !== 'object') return String(value)
  if ('result' in value) return cellText(value.result)
  if ('text' in value) return String(value.text ?? '')
  if ('hyperlink' in value) return String(value.text ?? value.hyperlink ?? '')
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? '').join('')
  if (typeof value.code === 'string') return value.code
  return String(value)
}

function csvField(value) {
  const text = cellText(value)
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function csvRow(values, width) {
  const cells = Array.from({ length: width }, (_, index) => csvField(values?.[index]))
  return Buffer.from(`${cells.join(',')}\r\n`, 'utf8')
}

function nonEmpty(values) {
  return values.some((value) => cellText(value).trim() !== '')
}

async function sha256(path) {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex').toUpperCase()
}

async function walk(path) {
  const info = await stat(path)
  if (info.isFile()) return [path]
  const entries = await readdir(path, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) files.push(...await walk(child))
    else if (entry.isFile() && SUPPORTED.has(extname(entry.name).toLowerCase())) files.push(child)
  }
  return files.sort()
}

function headersOf(sheet) {
  return (sheet.rows?.[0] ?? []).map((value) => cellText(value).trim())
}

function uniqueParsedHeaders(headers) {
  const seen = new Map()
  return headers.map((header, index) => {
    const normalized = header || `未命名列${index + 1}`
    const count = seen.get(normalized) ?? 0
    seen.set(normalized, count + 1)
    return count === 0 ? normalized : `${normalized}_${count + 1}`
  })
}

function rowRecords(sheet) {
  const width = headersOf(sheet).length
  const rows = []
  for (let index = 1; index < (sheet.rows?.length ?? 0); index += 1) {
    const values = sheet.rows[index] ?? []
    if (!nonEmpty(values)) continue
    rows.push({ physical_row: index + 1, values: Array.from({ length: width }, (_, column) => values[column]) })
  }
  return rows
}

function safeBase(filename) {
  return filename.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
}

function sourceRowRange(rows) {
  if (rows.length === 0) return null
  return { first: rows[0].physical_row, last: rows.at(-1).physical_row }
}

async function writeParts({ sourceGroup, sourceFilename, sheetName, headers, rows, outDir, sourceHash }) {
  const header = csvRow(headers, headers.length)
  const outputs = []
  let partBuffers = [header]
  let partBytes = header.length
  let partRows = []
  let partNumber = 1

  async function flush() {
    if (partRows.length === 0) return
    const suffix = String(partNumber).padStart(3, '0')
    const outputName = `${safeBase(sourceFilename)}_part${suffix}.csv`
    const outputPath = join(outDir, outputName)
    const outputBuffer = Buffer.concat(partBuffers, partBytes)
    await writeFile(outputPath, outputBuffer)
    const outputStats = await stat(outputPath)
    const parsed = await readCandidateImportFile({
      path: outputPath,
      originalname: outputName,
      mimetype: 'text/csv',
      size: outputStats.size
    })
    const expectedParsedHeaders = uniqueParsedHeaders(headers)
    if (parsed.headers.length !== expectedParsedHeaders.length || parsed.headers.some((value, index) => value !== expectedParsedHeaders[index])) {
      throw new Error(`staging header mismatch for ${outputName}`)
    }
    if (parsed.rows.length !== partRows.length) throw new Error(`staging row mismatch for ${outputName}`)
    outputs.push({
      source_group: sourceGroup,
      source_file: sourceFilename,
      source_sheet: sheetName,
      source_sha256: sourceHash,
      output_file: outputName,
      output_path: outputPath,
      output_bytes: outputStats.size,
      output_sha256: await sha256(outputPath),
      output_rows: partRows.length,
      source_row_range: sourceRowRange(partRows),
      parser_row_count: parsed.rows.length,
      parser_sheet_name: parsed.sheetName,
      parser_header_count: parsed.headers.length,
      parser_headers_match_unique_source: true
    })
    partNumber += 1
    partBuffers = [header]
    partBytes = header.length
    partRows = []
  }

  for (const row of rows) {
    const encoded = csvRow(row.values, headers.length)
    if (header.length + encoded.length > TARGET_BYTES) throw new Error(`single staging row exceeds byte target in ${sourceFilename}`)
    if (partRows.length > 0 && partBytes + encoded.length > TARGET_BYTES) await flush()
    partBuffers.push(encoded)
    partBytes += encoded.length
    partRows.push(row)
  }
  await flush()
  return outputs
}

function emptyStatus(value) {
  const text = cellText(value).trim()
  return text === '' || text.toUpperCase() === 'NULL' || text === '空'
}

function emptyDate(value) {
  const text = cellText(value).trim()
  return text === '' || text.toUpperCase() === 'NULL'
}

function firstHeader(headers, aliases) {
  const index = headers.findIndex((header) => aliases.includes(header))
  return index === -1 ? -1 : index
}

async function processTalentFile(path, outDir, headerFingerprint) {
  const sourceFilename = basename(path)
  const sourceHashBefore = await sha256(path)
  const workbook = readXls(await readFile(path))
  const fileOutputs = []
  let totalRows = 0
  for (let sheetIndex = 0; sheetIndex < workbook.sheets.length; sheetIndex += 1) {
    const sheet = workbook.sheets[sheetIndex]
    const headers = headersOf(sheet)
    if (headers.length !== 191 || !headers.includes('应聘者ID')) throw new Error(`talent header gate failed for ${sourceFilename}`)
    const fingerprint = JSON.stringify(headers)
    if (headerFingerprint.value == null) headerFingerprint.value = fingerprint
    if (headerFingerprint.value !== fingerprint) throw new Error(`talent header fingerprint mismatch for ${sourceFilename}`)
    const rows = rowRecords(sheet)
    totalRows += rows.length
    const outputs = await writeParts({ sourceGroup: 'talent_library', sourceFilename, sheetName: sheet.name ?? `Sheet${sheetIndex + 1}`, headers, rows, outDir, sourceHash: sourceHashBefore })
    fileOutputs.push({ sheet_index: sheetIndex + 1, sheet_name: sheet.name ?? `Sheet${sheetIndex + 1}`, source_rows: rows.length, output_parts: outputs })
  }
  const sourceHashAfter = await sha256(path)
  if (sourceHashBefore !== sourceHashAfter) throw new Error(`source changed: ${sourceFilename}`)
  return { source_file: sourceFilename, source_bytes: (await stat(path)).size, source_sha256_before: sourceHashBefore, source_sha256_after: sourceHashAfter, source_unchanged: true, source_rows: totalRows, sheets: fileOutputs }
}

async function processApplicantFile(path, outDir) {
  const sourceFilename = basename(path)
  const sourceHashBefore = await sha256(path)
  const workbook = readXls(await readFile(path))
  const sheets = []
  let totals = { original_rows: 0, excluded_double_empty_rows: 0, retained_rows: 0, status_only_rows: 0, date_only_rows: 0, both_non_empty_rows: 0, invalid_date_rows: 0, missing_id_rows: 0 }
  for (let sheetIndex = 0; sheetIndex < workbook.sheets.length; sheetIndex += 1) {
    const sheet = workbook.sheets[sheetIndex]
    const headers = headersOf(sheet)
    if (JSON.stringify(headers) !== JSON.stringify(['入职状态', '入职日期', '应聘者ID'])) throw new Error(`applicant header gate failed for ${sourceFilename}`)
    const statusIndex = firstHeader(headers, ['入职状态', '入职情况', 'hire_status'])
    const dateIndex = firstHeader(headers, ['入职日期', '入职时间', 'hire_date'])
    const idIndex = headers.indexOf('应聘者ID')
    const rows = rowRecords(sheet)
    const retained = []
    const stats = { original_rows: rows.length, excluded_double_empty_rows: 0, retained_rows: 0, status_only_rows: 0, date_only_rows: 0, both_non_empty_rows: 0, invalid_date_rows: 0, missing_id_rows: 0 }
    for (const row of rows) {
      const statusIsEmpty = emptyStatus(row.values[statusIndex])
      const dateIsEmpty = emptyDate(row.values[dateIndex])
      if (statusIsEmpty && dateIsEmpty) {
        stats.excluded_double_empty_rows += 1
        continue
      }
      retained.push(row)
      stats.retained_rows += 1
      if (!statusIsEmpty && dateIsEmpty) stats.status_only_rows += 1
      else if (statusIsEmpty && !dateIsEmpty) stats.date_only_rows += 1
      else stats.both_non_empty_rows += 1
      if (!dateIsEmpty && !normalizeHireDate(row.values[dateIndex])) stats.invalid_date_rows += 1
      if (cellText(row.values[idIndex]).trim() === '' || cellText(row.values[idIndex]).trim().toUpperCase() === 'NULL') stats.missing_id_rows += 1
    }
    const outputs = await writeParts({ sourceGroup: 'applicant_data', sourceFilename, sheetName: sheet.name ?? `Sheet${sheetIndex + 1}`, headers, rows: retained, outDir, sourceHash: sourceHashBefore })
    sheets.push({ sheet_index: sheetIndex + 1, sheet_name: sheet.name ?? `Sheet${sheetIndex + 1}`, ...stats, output_parts: outputs })
    for (const key of Object.keys(totals)) totals[key] += stats[key]
  }
  const sourceHashAfter = await sha256(path)
  if (sourceHashBefore !== sourceHashAfter) throw new Error(`source changed: ${sourceFilename}`)
  return { source_file: sourceFilename, source_bytes: (await stat(path)).size, source_sha256_before: sourceHashBefore, source_sha256_after: sourceHashAfter, source_unchanged: true, ...totals, sheets }
}

async function main() {
  const talentOut = join(staging, 'talent_library')
  const applicantOut = join(staging, 'applicant_data')
  await mkdir(talentOut, { recursive: true })
  await mkdir(applicantOut, { recursive: true })
  const talentFiles = await walk(rootA)
  const applicantFiles = await walk(rootB)
  const headerFingerprint = { value: null }
  const talent = []
  for (const path of talentFiles) talent.push(await processTalentFile(path, talentOut, headerFingerprint))
  const applicants = []
  for (const path of applicantFiles) applicants.push(await processApplicantFile(path, applicantOut))
  const manifest = {
    generated_at: new Date().toISOString(),
    target_part_bytes: TARGET_BYTES,
    api_max_file_size_bytes: 67108864,
    source_groups: { talent_library: talent, applicant_data: applicants },
    aggregate: {
      talent_source_rows: talent.reduce((sum, file) => sum + file.source_rows, 0),
      talent_output_rows: talent.reduce((sum, file) => sum + file.sheets.reduce((s, sheet) => s + sheet.output_parts.reduce((n, part) => n + part.output_rows, 0), 0), 0),
      talent_parts: talent.reduce((sum, file) => sum + file.sheets.reduce((s, sheet) => s + sheet.output_parts.length, 0), 0),
      applicant_original_rows: applicants.reduce((sum, file) => sum + file.original_rows, 0),
      applicant_excluded_double_empty_rows: applicants.reduce((sum, file) => sum + file.excluded_double_empty_rows, 0),
      applicant_retained_rows: applicants.reduce((sum, file) => sum + file.retained_rows, 0),
      applicant_parts: applicants.reduce((sum, file) => sum + file.sheets.reduce((s, sheet) => s + sheet.output_parts.length, 0), 0)
    }
  }
  await writeFile(join(staging, 'prepared-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  console.log(JSON.stringify({ generated_at: manifest.generated_at, target_part_bytes: TARGET_BYTES, aggregate: manifest.aggregate }))
}

await main()
