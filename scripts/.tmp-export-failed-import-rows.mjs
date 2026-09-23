// Reconstruct the user-requested failed-row table from staged CSV parts.
// The failure index contains coordinates and stable codes; tokens and payloads
// are never read. Raw values are written only to the explicitly requested CSV.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { readCandidateImportFile } from '../server/import-file.js'

const [
  manifestPath,
  failurePath,
  outputCsvPath,
  outputSummaryPath,
  progressPath,
  timeoutCsvPath,
  combinedCsvPath
] = process.argv.slice(2)
if (![manifestPath, failurePath, outputCsvPath, outputSummaryPath].every(Boolean)) {
  throw new Error(
    'usage: node scripts/.tmp-export-failed-import-rows.mjs <prepared-manifest.json> <failure-index.json> <failed-rows.csv> <failure-reasons.json> [progress.json] [timeout-unconfirmed-rows.csv] [combined-issue-rows.csv]'
  )
}

function csvField(value) {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function unique(values) {
  return [...new Set(values.filter((value) => value != null && String(value) !== ''))]
}

function safeCode(value, fallback = 'unknown') {
  const text = String(value ?? '').trim()
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(text) ? text : fallback
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const failureLog = JSON.parse(await readFile(failurePath, 'utf8'))
if (failureLog.group && failureLog.group !== 'talent_library') {
  throw new Error(`failure index group mismatch: ${failureLog.group}`)
}

const parts = (manifest.source_groups?.talent_library ?? []).flatMap((source) => (
  (source.sheets ?? []).flatMap((sheet) => (sheet.output_parts ?? []).map((part) => ({
    source_file: source.source_file,
    source_sheet: sheet.sheet_name,
    ...part
  })))
)).map((part, index) => ({ ...part, index: index + 1 }))
const byPart = new Map(parts.map((part) => [part.index, part]))

// Merge duplicate phase entries for one coordinate, but retain every event so
// the summary can report both affected rows and raw failure-event counts.
const rowFailures = new Map()
const unresolved = []
for (const entry of failureLog.entries ?? []) {
  const partIndex = Number(entry.part_index)
  const rowNumber = Number(entry.csv_row_number)
  if (!Number.isInteger(rowNumber)) {
    if (Number(entry.unresolved_count) > 0) unresolved.push({
      part_index: partIndex,
      source_file: entry.source_file,
      output_file: entry.output_file,
      phase: safeCode(entry.phase, 'unknown'),
      unresolved_count: Number(entry.unresolved_count),
      error_codes: unique((entry.error_codes ?? []).map((code) => safeCode(code)))
    })
    continue
  }
  if (!Number.isInteger(partIndex) || partIndex < 1) {
    throw new Error(`invalid failure coordinate: part=${entry.part_index} row=${entry.csv_row_number}`)
  }
  const key = `${partIndex}:${rowNumber}`
  const current = rowFailures.get(key) ?? {
    part_index: partIndex,
    csv_row_number: rowNumber,
    data_row_number: Number(entry.data_row_number ?? rowNumber - 1),
    source_file: entry.source_file,
    output_file: entry.output_file,
    phases: [],
    events: [],
    error_codes: []
  }
  const phase = safeCode(entry.phase, 'unknown')
  const codes = (entry.error_codes ?? []).map((code) => safeCode(code))
  current.phases.push(phase)
  current.events.push({ phase, error_codes: codes })
  current.error_codes.push(...codes)
  rowFailures.set(key, current)
}

const failuresByPart = new Map()
for (const failure of rowFailures.values()) {
  const list = failuresByPart.get(failure.part_index) ?? []
  list.push(failure)
  failuresByPart.set(failure.part_index, list)
}

const allHeaders = []
const headerSet = new Set()
const validationErrors = []
const parsedByPart = new Map()
async function parsePart(partIndex) {
  if (parsedByPart.has(partIndex)) return parsedByPart.get(partIndex)
  const part = byPart.get(partIndex)
  if (!part) {
    validationErrors.push({ part_index: partIndex, reason: 'manifest_part_missing' })
    return null
  }
  const info = await stat(part.output_path)
  const parsed = await readCandidateImportFile({
    path: part.output_path,
    originalname: basename(part.output_file),
    mimetype: 'text/csv',
    size: info.size
  })
  parsedByPart.set(partIndex, parsed)
  return parsed
}
for (const partIndex of [...failuresByPart.keys()].sort((a, b) => a - b)) {
  const part = byPart.get(partIndex)
  if (!part) {
    validationErrors.push({ part_index: partIndex, reason: 'manifest_part_missing' })
    continue
  }
  const parsed = await parsePart(partIndex)
  if (!parsed) continue
  for (const header of parsed.headers) {
    if (!headerSet.has(header)) {
      headerSet.add(header)
      allHeaders.push(header)
    }
  }
  const rowsByNumber = new Map((parsed.rows ?? []).map((row) => [Number(row.row_number), row]))
  for (const failure of failuresByPart.get(partIndex) ?? []) {
    if (failure.csv_row_number < 2 || failure.csv_row_number > parsed.rows.length + 1) {
      validationErrors.push({
        part_index: partIndex,
        csv_row_number: failure.csv_row_number,
        reason: 'row_number_out_of_bounds'
      })
      continue
    }
    const sourceRow = rowsByNumber.get(failure.csv_row_number)
    if (!sourceRow || !sourceRow.values || typeof sourceRow.values !== 'object') {
      validationErrors.push({
        part_index: partIndex,
        csv_row_number: failure.csv_row_number,
        reason: 'source_row_not_found'
      })
      continue
    }
    failure.source_headers = parsed.headers
    failure.source_values = sourceRow.values
  }
}

const metadataHeaders = [
  '来源文件', '来源分片', 'CSV行号', '数据行号', '失败阶段', '失败原因', '定位状态', '未定位数量'
]
const lines = [[...metadataHeaders, ...allHeaders].map(csvField).join(',')]
let rowsWithValues = 0
const rowReasonCounts = {}
const eventReasonCounts = {}
const phaseCounts = {}
const eventPhaseCounts = {}
const partCounts = {}

for (const failure of [...rowFailures.values()].sort((a, b) => (
  a.part_index - b.part_index || a.csv_row_number - b.csv_row_number
))) {
  const part = byPart.get(failure.part_index)
  const values = failure.source_values ?? {}
  const sourceHeaders = failure.source_headers ?? []
  const hasSourceValues = Boolean(
    failure.source_values && typeof failure.source_values === 'object' && !Array.isArray(failure.source_values)
  )
  if (hasSourceValues) rowsWithValues += 1
  const phases = unique(failure.phases).sort()
  const codes = unique(failure.error_codes).sort()
  const partSummary = partCounts[failure.part_index] ?? {
    indexed_rows: 0, unresolved_rows: 0, reason_counts: {}, phase_counts: {}
  }
  partSummary.indexed_rows += 1
  for (const phase of phases) {
    phaseCounts[phase] = Number(phaseCounts[phase] ?? 0) + 1
    partSummary.phase_counts[phase] = Number(partSummary.phase_counts[phase] ?? 0) + 1
  }
  for (const code of codes) {
    rowReasonCounts[code] = Number(rowReasonCounts[code] ?? 0) + 1
    partSummary.reason_counts[code] = Number(partSummary.reason_counts[code] ?? 0) + 1
  }
  for (const event of failure.events ?? []) {
    const phase = safeCode(event.phase, 'unknown')
    eventPhaseCounts[phase] = Number(eventPhaseCounts[phase] ?? 0) + 1
    for (const code of event.error_codes ?? []) {
      const normalized = safeCode(code)
      eventReasonCounts[normalized] = Number(eventReasonCounts[normalized] ?? 0) + 1
    }
  }
  partCounts[failure.part_index] = partSummary
  const byHeader = new Map(sourceHeaders.map((header) => [header, values[header] ?? '']))
  lines.push([
    part?.source_file ?? failure.source_file ?? '',
    part?.output_file ?? failure.output_file ?? '',
    failure.csv_row_number,
    failure.data_row_number,
    phases.join(';'),
    codes.join(';'),
    hasSourceValues ? '已定位' : '未定位',
    '',
    ...allHeaders.map((header) => byHeader.get(header) ?? '')
  ].map(csvField).join(','))
}

// An unresolved entry represents a count of failed rows for which the API did
// not return coordinates. Keep it in the table as an explicit count row.
for (const entry of unresolved.sort((a, b) => (
  a.part_index - b.part_index || a.phase.localeCompare(b.phase)
))) {
  const part = byPart.get(entry.part_index)
  const partSummary = partCounts[entry.part_index] ?? {
    indexed_rows: 0, unresolved_rows: 0, reason_counts: {}, phase_counts: {}
  }
  partSummary.unresolved_rows += entry.unresolved_count
  partCounts[entry.part_index] = partSummary
  eventPhaseCounts[entry.phase] = Number(eventPhaseCounts[entry.phase] ?? 0) + 1
  for (const code of entry.error_codes) {
    eventReasonCounts[code] = Number(eventReasonCounts[code] ?? 0) + entry.unresolved_count
  }
  lines.push([
    part?.source_file ?? entry.source_file ?? '',
    part?.output_file ?? entry.output_file ?? '',
    '',
    '',
    entry.phase,
    entry.error_codes.join(';'),
    '未定位',
    entry.unresolved_count,
    ...allHeaders.map(() => '')
  ].map(csvField).join(','))
}

await mkdir(dirname(outputCsvPath), { recursive: true })
await writeFile(outputCsvPath, `\uFEFF${lines.join('\r\n')}\r\n`, { encoding: 'utf8', mode: 0o600 })

const progress = progressPath ? JSON.parse(await readFile(progressPath, 'utf8')) : null
const timeoutRows = []
const timeoutPartCounts = {}
if (progress?.parts) {
  for (const [partIndexText, partState] of Object.entries(progress.parts)) {
    const partIndex = Number(partIndexText)
    if (partState.status !== 'stopped' || partState.error_code !== 'import_commit_timeout') continue
    const part = byPart.get(partIndex)
    const parsed = await parsePart(partIndex)
    if (!part || !parsed) continue
    for (const header of parsed.headers) {
      if (!headerSet.has(header)) {
        headerSet.add(header)
        allHeaders.push(header)
      }
    }
    const indexedFailureRows = new Set(
      (failuresByPart.get(partIndex) ?? []).map((failure) => failure.csv_row_number)
    )
    const expectedRows = Number(part.output_rows ?? 0)
    if (expectedRows > 0 && parsed.rows.length !== expectedRows) {
      validationErrors.push({
        part_index: partIndex,
        reason: 'timeout_source_row_count_mismatch',
        expected_rows: expectedRows,
        actual_rows: parsed.rows.length
      })
    }
    const rows = parsed.rows.filter((row) => !indexedFailureRows.has(Number(row.row_number)))
    timeoutPartCounts[partIndex] = {
      source_rows: parsed.rows.length,
      indexed_failure_rows: indexedFailureRows.size,
      timeout_unconfirmed_rows: rows.length,
      expected_timeout_unconfirmed_rows: Math.max(0, parsed.rows.length - indexedFailureRows.size)
    }
    for (const row of rows) {
      timeoutRows.push({
        part_index: partIndex,
        csv_row_number: Number(row.row_number),
        data_row_number: Number(row.row_number) - 1,
        source_file: part.source_file,
        output_file: part.output_file,
        source_headers: parsed.headers,
        source_values: row.values
      })
    }
  }
}

if (timeoutCsvPath) {
  const timeoutMetadataHeaders = [
    '来源文件', '来源分片', 'CSV行号', '数据行号', '记录类型', '处理状态',
    '失败阶段', '失败原因', '定位状态', '未定位数量'
  ]
  const timeoutLines = [[...timeoutMetadataHeaders, ...allHeaders].map(csvField).join(',')]
  for (const row of timeoutRows.sort((a, b) => (
    a.part_index - b.part_index || a.csv_row_number - b.csv_row_number
  ))) {
    const byHeader = new Map(row.source_headers.map((header) => [header, row.source_values?.[header] ?? '']))
    timeoutLines.push([
      row.source_file,
      row.output_file,
      row.csv_row_number,
      row.data_row_number,
      '提交结果未确认',
      '第18片提交超时',
      'commit_timeout_unconfirmed',
      'import_commit_timeout',
      '已定位',
      '',
      ...allHeaders.map((header) => byHeader.get(header) ?? '')
    ].map(csvField).join(','))
  }
  await mkdir(dirname(timeoutCsvPath), { recursive: true })
  await writeFile(timeoutCsvPath, `\uFEFF${timeoutLines.join('\r\n')}\r\n`, { encoding: 'utf8', mode: 0o600 })
}

if (combinedCsvPath) {
  const combinedMetadataHeaders = [
    '来源文件', '来源分片', 'CSV行号', '数据行号', '记录类别', '处理状态',
    '失败阶段', '失败原因', '定位状态', '未定位数量'
  ]
  const combinedLines = [[...combinedMetadataHeaders, ...allHeaders].map(csvField).join(',')]
  for (const failure of [...rowFailures.values()].sort((a, b) => (
    a.part_index - b.part_index || a.csv_row_number - b.csv_row_number
  ))) {
    const part = byPart.get(failure.part_index)
    const values = failure.source_values ?? {}
    const sourceHeaders = failure.source_headers ?? []
    const hasSourceValues = Boolean(
      failure.source_values && typeof failure.source_values === 'object' && !Array.isArray(failure.source_values)
    )
    const phases = unique(failure.phases).sort()
    const codes = unique(failure.error_codes).sort()
    const partState = progress?.parts?.[String(failure.part_index)]
    const status = phases.includes('commit_failed')
      ? '正式提交失败'
      : partState?.status === 'completed'
        ? '正式提交失败（明细省略）'
        : '预览判定无效（未正式提交）'
    const byHeader = new Map(sourceHeaders.map((header) => [header, values[header] ?? '']))
    combinedLines.push([
      part?.source_file ?? failure.source_file ?? '',
      part?.output_file ?? failure.output_file ?? '',
      failure.csv_row_number,
      failure.data_row_number,
      '明确失败/无效',
      status,
      phases.join(';'),
      codes.join(';'),
      hasSourceValues ? '已定位' : '未定位',
      '',
      ...allHeaders.map((header) => byHeader.get(header) ?? '')
    ].map(csvField).join(','))
  }
  for (const row of timeoutRows.sort((a, b) => (
    a.part_index - b.part_index || a.csv_row_number - b.csv_row_number
  ))) {
    const byHeader = new Map(row.source_headers.map((header) => [header, row.source_values?.[header] ?? '']))
    combinedLines.push([
      row.source_file,
      row.output_file,
      row.csv_row_number,
      row.data_row_number,
      '提交结果未确认',
      '第18片提交超时',
      'commit_timeout_unconfirmed',
      'import_commit_timeout',
      '已定位',
      '',
      ...allHeaders.map((header) => byHeader.get(header) ?? '')
    ].map(csvField).join(','))
  }
  await mkdir(dirname(combinedCsvPath), { recursive: true })
  await writeFile(combinedCsvPath, `\uFEFF${combinedLines.join('\r\n')}\r\n`, { encoding: 'utf8', mode: 0o600 })
}

const coverage = {}
if (progress?.parts) {
  for (const [partIndex, partState] of Object.entries(progress.parts)) {
    const indexed = [...rowFailures.values()].filter((row) => row.part_index === Number(partIndex))
    const previewRows = indexed.filter((row) => row.phases.includes('preview_invalid')).length
    const commitRows = indexed.filter((row) => row.phases.includes('commit_failed')).length
    const omitted = Number(partState.commit?.failure_details_omitted ?? 0)
    const expectedCommit = Number(partState.commit?.failed_rows ?? 0)
    const expectedPreview = partState.preview?.invalid_rows == null
      ? null
      : Number(partState.preview.invalid_rows)
    coverage[partIndex] = {
      status: partState.status,
      expected_preview_invalid_rows: expectedPreview,
      indexed_preview_invalid_rows: previewRows,
      expected_commit_failed_rows: expectedCommit,
      indexed_commit_failed_rows: commitRows,
      commit_failure_details_omitted: omitted,
      commit_failure_coverage: expectedCommit === 0
        ? (partState.status === 'completed' ? 'not_applicable' : 'not_applicable_incomplete')
        : expectedCommit === previewRows && previewRows === Number(expectedPreview ?? -1)
          ? 'covered_by_preview_coordinates'
          : commitRows + omitted >= expectedCommit
            ? 'count_only_for_omitted'
            : 'incomplete'
    }
  }
}
const coverageFailures = Object.entries(coverage)
  .filter(([, item]) => item.status === 'completed')
  .filter(([, item]) => (
    item.indexed_preview_invalid_rows !== item.expected_preview_invalid_rows ||
    item.commit_failure_coverage === 'incomplete'
  ))
  .map(([part_index, item]) => ({ part_index: Number(part_index), ...item }))

const manifestPartCount = parts.length
const progressPartEntries = Object.entries(progress?.parts ?? {})
const completedPartCount = progressPartEntries.filter(([, item]) => item.status === 'completed').length
const reportStatus = manifestPartCount > 0 && completedPartCount === manifestPartCount
  ? 'final'
  : 'intermediate'

const summary = {
  schema_version: 2,
  generated_at: new Date().toISOString(),
  group: 'talent_library',
  report_status: reportStatus,
  completion: {
    completed_parts: completedPartCount,
    total_parts: manifestPartCount
  },
  failed_rows_indexed: rowFailures.size,
  failed_rows_with_source_values: rowsWithValues,
  unresolved_failure_entries: unresolved.length,
  unresolved_failure_rows: unresolved.reduce((sum, entry) => sum + Number(entry.unresolved_count ?? 0), 0),
  phase_counts: phaseCounts,
  event_phase_counts: eventPhaseCounts,
  row_reason_counts: rowReasonCounts,
  event_reason_counts: eventReasonCounts,
  part_counts: partCounts,
  coverage,
  validation_errors: validationErrors,
  coverage_failures: coverageFailures,
  output_csv: basename(outputCsvPath),
  timeout_unconfirmed_rows: timeoutRows.length,
  timeout_unconfirmed_part_counts: timeoutPartCounts,
  timeout_output_csv: timeoutCsvPath ? basename(timeoutCsvPath) : null,
  combined_output_csv: combinedCsvPath ? basename(combinedCsvPath) : null,
  privacy_notice: 'User-requested local failure table; contains original failed-row values. No preview tokens are included.'
}
await writeFile(outputSummaryPath, JSON.stringify(summary, null, 2), { encoding: 'utf8', mode: 0o600 })
console.log(JSON.stringify({
  event: 'failed_rows_exported',
  failed_rows_indexed: summary.failed_rows_indexed,
  failed_rows_with_source_values: summary.failed_rows_with_source_values,
  unresolved_failure_entries: summary.unresolved_failure_entries,
  unresolved_failure_rows: summary.unresolved_failure_rows,
  row_reason_counts: summary.row_reason_counts,
  event_reason_counts: summary.event_reason_counts,
  report_status: summary.report_status,
  completion: summary.completion,
  timeout_unconfirmed_rows: summary.timeout_unconfirmed_rows,
  validation_errors: summary.validation_errors.length,
  coverage_failures: summary.coverage_failures.length
}))

if (validationErrors.length || coverageFailures.length) process.exitCode = 1
