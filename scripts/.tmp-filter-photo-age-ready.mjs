import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { readCandidateImportFile } from '../server/import-file.js'

const inputPath = 'C:/Users/cboy/Documents/北森/output/candidate-import-photo-age-failures-corrected-20260828.csv'
const outputPath = 'C:/Users/cboy/Documents/北森/output/candidate-import-photo-age-failures-ready-20260828.csv'
const excludedRows = new Set([6, 9, 18, 41, 42])

function csvField(value) {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const parsed = await readCandidateImportFile({
  path: inputPath,
  originalname: basename(inputPath),
  mimetype: 'text/csv'
})
if (parsed.rows.length !== 51) throw new Error(`unexpected_rows:${parsed.rows.length}`)
const kept = parsed.rows.filter((row) => !excludedRows.has(Number(row.row_number)))
if (kept.length !== 46) throw new Error(`unexpected_kept_rows:${kept.length}`)
const lines = [parsed.headers.map(csvField).join(',')]
for (const row of kept) lines.push(parsed.headers.map((header) => csvField(row.values?.[header] ?? '')).join(','))
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `\uFEFF${lines.join('\r\n')}\r\n`, { encoding: 'utf8', mode: 0o600 })
console.log(JSON.stringify({ input_rows: parsed.rows.length, excluded_rows: excludedRows.size, output_rows: kept.length, output: basename(outputPath) }))
