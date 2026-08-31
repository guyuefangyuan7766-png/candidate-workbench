import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { readCandidateImportFile } from '../server/import-file.js'
import { normalizeEmail, normalizePhone } from '../server/validation.js'

const manifestPath = 'C:/Users/cboy/AppData/Local/Temp/candidate-workbench-import-20260826-a-rerun-02d7fcea2e29458e83f16195845adf9e/prepared-manifest.json'
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const parts = (manifest.source_groups?.talent_library ?? [])
  .flatMap((source) => (source.sheets ?? []).flatMap((sheet) => sheet.output_parts ?? []))
const part = parts[9]
const parsed = await readCandidateImportFile({
  path: part.output_path,
  originalname: part.output_file,
  mimetype: 'text/csv',
  size: (await stat(part.output_path)).size
})
const row = parsed.rows.find((item) => Number(item.row_number) === 5481)
const values = row?.values ?? {}
const first = (keys) => {
  for (const key of keys) {
    const value = String(values[key] ?? '').trim()
    if (value) return value
  }
  return ''
}
const rawPhone = first(['手机号码', '手机号', '手机', '联系电话'])
const rawEmail = first(['邮箱', '电子邮箱'])
const sourceRecordId = first(['应聘者ID'])
const phone = normalizePhone(rawPhone)
const email = normalizeEmail(rawEmail)
const hash = (value) => createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16)

const db = new DatabaseSync('data/recruitment.db', { readOnly: true })
const matches = db.prepare(`
  SELECT id, phone, email, source_system, source_record_id, import_batch_id, created_at, updated_at, archived_at
  FROM candidates
  WHERE phone = ? OR email = ? OR (source_system = ? AND source_record_id = ?)
  ORDER BY id
`).all(phone, email, 'beisen', sourceRecordId)
const result = {
  row_number: 5481,
  raw_phone_hash: hash(rawPhone),
  normalized_phone_hash: hash(phone),
  raw_email_hash: hash(rawEmail),
  normalized_email_hash: hash(email),
  source_record_hash: hash(sourceRecordId),
  matches: matches.map((match) => ({
    id_hash: hash(match.id),
    phone_hash: hash(match.phone),
    email_hash: hash(match.email),
    source_record_hash: hash(match.source_record_id),
    import_batch_id: match.import_batch_id,
    created_at: match.created_at,
    updated_at: match.updated_at,
    phone_match: match.phone === phone,
    email_match: match.email === email,
    source_match: match.source_system === 'beisen' && match.source_record_id === sourceRecordId,
    archived: Boolean(match.archived_at)
  }))
}
console.log(JSON.stringify(result, null, 2))
db.close()
