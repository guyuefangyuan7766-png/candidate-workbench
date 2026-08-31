// Temporary read-only source inventory helper; generated artifacts stay in the OS temp staging directory.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import ExcelJS from 'exceljs'
import { readXls } from 'xls-reader'

const [rootA, rootB, staging] = process.argv.slice(2)
const supported = new Set(['.xls', '.xlsx', '.xlsm', '.csv'])

async function walk(path) {
  const info = await stat(path)
  if (info.isFile()) return [path]
  const out = []
  for (const item of await readdir(path, { withFileTypes: true })) {
    const child = join(path, item.name)
    if (item.isDirectory()) out.push(...await walk(child))
    else if (item.isFile()) out.push(child)
  }
  return out
}

async function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()))
  })
}

function cellText(value) {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object') return String(value)
  if ('result' in value) return cellText(value.result)
  if ('text' in value) return String(value.text ?? '')
  if ('hyperlink' in value) return String(value.text ?? value.hyperlink ?? '')
  if (Array.isArray(value.richText)) return value.richText.map((p) => p.text ?? '').join('')
  return String(value)
}

function headerValues(values) {
  return Array.from(values ?? []).slice(0).map((v) => cellText(v).trim())
}

function nonEmptyRow(row) {
  return row.some((v) => cellText(v).trim() !== '')
}

async function inspectXls(path) {
  const buffer = await readFile(path)
  const workbook = readXls(buffer)
  const sheets = workbook.sheets.map((sheet, index) => {
    const headers = headerValues(sheet.rows[0] ?? [])
    const dataRows = sheet.rows.slice(1)
    const nonEmpty = dataRows.filter(nonEmptyRow)
    return {
      index: index + 1,
      name: sheet.name ?? `Sheet${index + 1}`,
      physical_rows_including_header: sheet.rows.length,
      data_rows_including_empty: dataRows.length,
      non_empty_data_rows: nonEmpty.length,
      column_count: headers.length,
      headers,
      exact_beisen_id_header: headers.includes('应聘者ID'),
      hire_status_headers: headers.filter((h) => h === '入职状态' || h === '入职情况' || h === 'hire_status'),
      hire_date_headers: headers.filter((h) => h === '入职日期' || h === '入职时间' || h === 'hire_date'),
      years_experience_headers: headers.filter((h) => h === '工作年限' || h === 'years_experience')
    }
  })
  return { format: 'xls', sheets }
}

async function inspectXlsx(path, extension) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(path)
  const sheets = workbook.worksheets.map((sheet, index) => {
    const headers = headerValues(sheet.getRow(1).values.slice(1))
    let nonEmpty = 0
    for (let row = 2; row <= sheet.rowCount; row += 1) {
      const values = sheet.getRow(row).values.slice(1)
      if (nonEmptyRow(values)) nonEmpty += 1
    }
    return {
      index: index + 1,
      name: sheet.name,
      physical_rows_including_header: sheet.rowCount,
      data_rows_including_empty: Math.max(0, sheet.rowCount - 1),
      non_empty_data_rows: nonEmpty,
      column_count: headers.length,
      headers,
      exact_beisen_id_header: headers.includes('应聘者ID'),
      hire_status_headers: headers.filter((h) => h === '入职状态' || h === '入职情况' || h === 'hire_status'),
      hire_date_headers: headers.filter((h) => h === '入职日期' || h === '入职时间' || h === 'hire_date'),
      years_experience_headers: headers.filter((h) => h === '工作年限' || h === 'years_experience')
    }
  })
  return { format: extension.slice(1), sheets }
}

async function inspectCsv(path) {
  const text = await readFile(path, 'utf8')
  const lines = text.split(/\r?\n/)
  while (lines.length && lines.at(-1) === '') lines.pop()
  const headers = (lines[0] ?? '').replace(/^\uFEFF/, '').split(',').map((v) => v.trim())
  return {
    format: 'csv',
    sheets: [{ index: 1, name: 'CSV', physical_rows_including_header: lines.length, data_rows_including_empty: Math.max(0, lines.length - 1), non_empty_data_rows: lines.slice(1).filter((line) => line.trim() !== '').length, column_count: headers.length, headers, exact_beisen_id_header: headers.includes('应聘者ID'), hire_status_headers: headers.filter((h) => h === '入职状态' || h === '入职情况' || h === 'hire_status'), hire_date_headers: headers.filter((h) => h === '入职日期' || h === '入职时间' || h === 'hire_date'), years_experience_headers: headers.filter((h) => h === '工作年限' || h === 'years_experience') }]
  }
}

async function inspect(path) {
  const info = await stat(path)
  const extension = extname(path).toLowerCase()
  const base = { filename: basename(path), relative_path: relative(process.cwd(), path), size_bytes: info.size, sha256_before: await sha256(path), extension }
  let details
  if (extension === '.xls') details = await inspectXls(path)
  else if (extension === '.xlsx' || extension === '.xlsm') details = await inspectXlsx(path, extension)
  else if (extension === '.csv') details = await inspectCsv(path)
  else details = { format: 'unsupported', sheets: [] }
  return { ...base, ...details }
}

const all = []
for (const [label, root] of [['talent_library', rootA], ['applicant_data', rootB]]) {
  const paths = await walk(root)
  const files = []
  for (const path of paths.sort()) {
    const extension = extname(path).toLowerCase()
    if (!supported.has(extension)) continue
    files.push(await inspect(path))
  }
  all.push({ label, root, supported_file_count: files.length, files })
}
const manifest = { generated_at: new Date().toISOString(), supported_extensions: [...supported], source_groups: all }
await writeFile(join(staging, 'source-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
console.log(JSON.stringify({ generated_at: manifest.generated_at, groups: all.map((g) => ({ label: g.label, files: g.supported_file_count, bytes: g.files.reduce((s, f) => s + f.size_bytes, 0), sheets: g.files.reduce((s, f) => s + f.sheets.length, 0), non_empty_rows: g.files.reduce((s, f) => s + f.sheets.reduce((n, sh) => n + sh.non_empty_data_rows, 0), 0) })) }))
