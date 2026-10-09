import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export const MAX_SOURCE_ROWS = 400
// 口径 B（2026-10-07 定档，见 docs/VECTOR_HYBRID_PLAN.md §3.1）：原 5 类 + 阶段 3 模型解析出的 7 类。
export const SAFE_SECTIONS = ['education', 'education_experience', 'experience', 'work_experience', 'work', 'project', 'project_experience', 'internship', 'skill', 'skills', 'award', 'certificate', 'campus', 'language', 'management', 'publication', 'training']
// `other` 只收模型解析写出的「附加信息」，不收导入器生成的「来源索引 / 身份与证件 / 附加资料与素材」。
export const PARSED_OTHER_SECTION_WHERE = "s.section_type = 'other' AND s.source_record_id LIKE 'origin-section-parse-v1:%'"
const placeholders = values => values.map(() => '?').join(',')
const fail = () => { const error = new Error('Source page exceeds bounded limit'); error.code = 'search_vector_source_budget'; throw error }
export function materialSourceHash(document) {
  return createHash('sha256').update(JSON.stringify([document.document_id, document.candidate_id, document.source_type, document.source_id, document.field ?? 'content', document.title ?? '', document.content ?? ''])).digest('hex')
}

// Source prefixes are ordered once; paging each original primary key avoids a
// concatenated-key full scan and sort of all resumes on every network batch.
// The candidate join is a CROSS JOIN so the planner keeps the source table first:
// driving from candidates scans the whole table to find the requested ids instead
// of looking those ids up directly by primary key.
const SOURCES = [
  { prefix: 'attachment:', id: 'a.id', candidate: 'a.candidate_id', type: 'attachment', from: 'candidate_attachments a CROSS JOIN candidates c ON c.id=a.candidate_id', select: "a.candidate_id,'attachment' AS source_type,a.id AS source_id,'Resume attachment' AS title,'extracted_text' AS field,a.extracted_text AS content,a.updated_at AS revision", content: 'a.extracted_text', revision: "a.updated_at || '|' || length(coalesce(a.original_filename,'')) || '|' || length(coalesce(a.extracted_text,''))", where: "c.archived_at IS NULL AND a.parse_status='parsed' AND a.attachment_type IN ('resume','resume_origin')", params: [] },
  { prefix: 'candidate:', id: 'c.id', candidate: 'c.id', type: 'candidate', from: 'candidates c', select: "c.id AS candidate_id,'candidate' AS source_type,c.id AS source_id,'Profile' AS title,'profile' AS field,coalesce(c.current_title,'') || char(10) || coalesce(c.current_company,'') || char(10) || coalesce(c.self_summary,'') || char(10) || CASE WHEN json_valid(c.tags) AND json_type(c.tags)='array' THEN coalesce((SELECT group_concat(value, char(10)) FROM json_each(c.tags) WHERE type='text'),'') ELSE '' END AS content,c.updated_at AS revision", content: 'content', revision: "c.updated_at || '|' || length(coalesce(c.current_title,'')) || '|' || length(coalesce(c.current_company,'')) || '|' || length(coalesce(c.self_summary,'')) || '|' || length(coalesce(c.tags,''))", where: 'c.archived_at IS NULL', params: [] },
  { prefix: 'section:', id: 's.id', candidate: 's.candidate_id', type: 'profile_section', from: 'candidate_profile_sections s CROSS JOIN candidates c ON c.id=s.candidate_id', select: "s.candidate_id,'profile_section' AS source_type,s.id AS source_id,coalesce(s.title,s.section_type) AS title,'content' AS field,s.content,s.updated_at AS revision", content: 's.content', revision: "s.updated_at || '|' || length(coalesce(s.title,'')) || '|' || length(coalesce(s.content,''))", where: `c.archived_at IS NULL AND s.archived_at IS NULL AND s.sensitivity <> 'high' AND (s.section_type IN (${placeholders(SAFE_SECTIONS)}) OR (${PARSED_OTHER_SECTION_WHERE}))`, params: SAFE_SECTIONS }
]

// Maintenance only needs to know *whether* a document changed, so this projection
// reads the trigger-maintained revision and text lengths instead of the resume body.
//
// It is driven by the `candidate_resume_documents` primary key, which scans
// sequentially. Cursoring the three source tables instead, or joining them for the
// eligibility predicates, makes the planner read a random row per document and is
// two orders of magnitude slower on this corpus. The stream is therefore a superset
// of the indexed documents: a document that stopped being eligible has no readable
// body, which is what tells the caller to drop it from the index.
//
// Candidate archival belongs in the revision itself: the row survives in the
// trigger table, so nothing else would reveal that the document left the index.
// `CROSS JOIN` keeps the rowid scan first — the planner otherwise drives from
// `candidates` and re-sorts the whole table.
export function readSearchDocumentRevisions(databaseOrPath, { after = 0, limit = MAX_SOURCE_ROWS, documentIds } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SOURCE_ROWS || !Number.isInteger(after) || after < 0) fail()
  if ((documentIds?.length ?? 0) > MAX_SOURCE_ROWS) fail()
  if (documentIds?.length === 0) return []
  const owns = typeof databaseOrPath === 'string'
  const db = owns ? new DatabaseSync(databaseOrPath, { readOnly: true }) : databaseOrPath
  try {
    const params = [after]
    let filter = ''
    if (documentIds) {
      const ids = [...new Set(documentIds.map(String))]
      filter = ` AND d.document_id IN (${placeholders(ids)})`
      params.push(...ids)
    }
    return db.prepare(`SELECT d.row_id AS row_id,d.document_id AS document_id,d.candidate_id AS candidate_id,d.source_type AS source_type,
        d.updated_at || '|' || length(coalesce(d.title,'')) || '|' || length(coalesce(d.content,'')) || '|' || coalesce(p.archived_at,'') AS revision
      FROM candidate_resume_documents d
      CROSS JOIN candidates p ON p.id = d.candidate_id
      WHERE d.row_id > ?${filter}
      ORDER BY d.row_id LIMIT ?`).all(...params, limit)
  } finally { if (owns) db.close() }
}

// Pruning asks the opposite question of the revision stream: which indexed
// documents no longer exist at all. The trigger table answers it by primary key.
export function filterExistingDocuments(databaseOrPath, ids) {
  if (!Array.isArray(ids) || ids.length > MAX_SOURCE_ROWS) fail()
  if (!ids.length) return new Set()
  const owns = typeof databaseOrPath === 'string'
  const db = owns ? new DatabaseSync(databaseOrPath, { readOnly: true }) : databaseOrPath
  const unique = [...new Set(ids.map(String))]
  try {
    return new Set(db.prepare(`SELECT document_id FROM candidate_resume_documents WHERE document_id IN (${placeholders(unique)})`).all(...unique).map(row => row.document_id))
  } finally { if (owns) db.close() }
}

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
