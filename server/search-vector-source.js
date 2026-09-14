import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export const MAX_SOURCE_ROWS = 400
export const SAFE_SECTIONS = ['education', 'education_experience', 'experience', 'work_experience', 'work', 'project', 'project_experience', 'internship', 'skill', 'skills']
const placeholders = values => values.map(() => '?').join(',')
const fail = () => { const error = new Error('Source page exceeds bounded limit'); error.code = 'search_vector_source_budget'; throw error }
export function materialSourceHash(document) {
  return createHash('sha256').update(JSON.stringify([document.document_id, document.candidate_id, document.source_type, document.source_id, document.field ?? 'content', document.title ?? '', document.content ?? ''])).digest('hex')
}

// Source prefixes are ordered once; paging each original primary key avoids a
// concatenated-key full scan and sort of all resumes on every network batch.
const SOURCES = [
  { prefix: 'attachment:', id: 'a.id', candidate: 'a.candidate_id', from: 'candidate_attachments a JOIN candidates c ON c.id=a.candidate_id', select: "a.candidate_id,'attachment' AS source_type,a.id AS source_id,'Resume attachment' AS title,'extracted_text' AS field,a.extracted_text AS content,a.updated_at AS revision", content: 'a.extracted_text', where: "c.archived_at IS NULL AND a.parse_status='parsed' AND a.attachment_type='resume'", params: [] },
  { prefix: 'candidate:', id: 'c.id', candidate: 'c.id', from: 'candidates c', select: "c.id AS candidate_id,'candidate' AS source_type,c.id AS source_id,'Profile' AS title,'profile' AS field,coalesce(c.current_title,'') || char(10) || coalesce(c.current_company,'') || char(10) || coalesce(c.self_summary,'') || char(10) || CASE WHEN json_valid(c.tags) AND json_type(c.tags)='array' THEN coalesce((SELECT group_concat(value, char(10)) FROM json_each(c.tags) WHERE type='text'),'') ELSE '' END AS content,c.updated_at AS revision", content: 'content', where: 'c.archived_at IS NULL', params: [] },
  { prefix: 'section:', id: 's.id', candidate: 's.candidate_id', from: 'candidate_profile_sections s JOIN candidates c ON c.id=s.candidate_id', select: "s.candidate_id,'profile_section' AS source_type,s.id AS source_id,coalesce(s.title,s.section_type) AS title,'content' AS field,s.content,s.updated_at AS revision", content: 's.content', where: `c.archived_at IS NULL AND s.archived_at IS NULL AND s.sensitivity <> 'high' AND s.section_type IN (${placeholders(SAFE_SECTIONS)})`, params: SAFE_SECTIONS }
]

export function readSearchDocuments(databaseOrPath, { after = '', limit = MAX_SOURCE_ROWS, candidateIds, documentIds } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SOURCE_ROWS || typeof after !== 'string') fail()
  if ((candidateIds?.length ?? 0) > MAX_SOURCE_ROWS || (documentIds?.length ?? 0) > MAX_SOURCE_ROWS) fail()
  if (candidateIds?.length === 0 || documentIds?.length === 0) return []
  const owns = typeof databaseOrPath === 'string'
  const db = owns ? new DatabaseSync(databaseOrPath, { readOnly: true }) : databaseOrPath
  const result = []
  try {
    for (const source of SOURCES) {
      if (result.length === limit) break
      if (after && !after.startsWith(source.prefix) && source.prefix < after) continue
      const clauses = [source.where, `${source.id} > ?`, `${source.content} IS NOT NULL`, `trim(${source.content}) <> ''`]
      const params = [...source.params, after.startsWith(source.prefix) ? after.slice(source.prefix.length) : '']
      if (candidateIds) { const ids = [...new Set(candidateIds.map(String))]; clauses.push(`${source.candidate} IN (${placeholders(ids)})`); params.push(...ids) }
      if (documentIds) {
        const ids = [...new Set(documentIds.map(String).filter(id => id.startsWith(source.prefix)).map(id => id.slice(source.prefix.length)))]
        if (!ids.length) continue
        clauses.push(`${source.id} IN (${placeholders(ids)})`); params.push(...ids)
      }
      const rows = db.prepare(`SELECT '${source.prefix}' || ${source.id} AS document_id,${source.select} FROM ${source.from} WHERE ${clauses.join(' AND ')} ORDER BY ${source.id} LIMIT ?`).all(...params, limit-result.length)
      result.push(...rows.map(row => ({ ...row, source_hash: materialSourceHash(row) })))
    }
    return result
  } finally { if (owns) db.close() }
}
