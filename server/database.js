import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_STAGES } from './constants.js'
import { migrateAttachmentBatchDatabase } from './attachment-batches.js'
import { migrateBusinessSearch, synchronizeBusinessSearch } from './business-search.js'
import { normalizeAge, normalizeBirthDate, normalizeGender, normalizePhotoUrl } from './validation.js'

export const DEFAULT_DATABASE_PATH = resolve(process.cwd(), 'data', 'recruitment.db')

const duplicateStatementCache = new WeakMap()
const activityInsertStatementCache = new WeakMap()
const transactionSearchPolicy = new WeakMap()

function duplicateStatements(db) {
  let statements = duplicateStatementCache.get(db)
  if (statements) return statements
  statements = {
    source: db.prepare(`
      SELECT id, name FROM candidates
      WHERE source_system = ? AND source_record_id = ?
    `),
    sourceExcluding: db.prepare(`
      SELECT id, name FROM candidates
      WHERE source_system = ? AND source_record_id = ? AND id <> ?
    `),
    email: db.prepare('SELECT id, name FROM candidates WHERE email = ?'),
    emailExcluding: db.prepare('SELECT id, name FROM candidates WHERE email = ? AND id <> ?'),
    phone: db.prepare('SELECT id, name FROM candidates WHERE phone = ?'),
    phoneExcluding: db.prepare('SELECT id, name FROM candidates WHERE phone = ? AND id <> ?')
  }
  duplicateStatementCache.set(db, statements)
  return statements
}

function activityInsertStatement(db) {
  let statement = activityInsertStatementCache.get(db)
  if (statement) return statement
  statement = db.prepare(`
    INSERT INTO activities(id, candidate_id, type, description, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  activityInsertStatementCache.set(db, statement)
  return statement
}

export function configuredDatabasePath() {
  if (process.env.DB_PATH) return resolve(process.env.DB_PATH)
  if (process.env.APP_DATA_DIR) return resolve(process.env.APP_DATA_DIR, 'recruitment.db')
  return DEFAULT_DATABASE_PATH
}

function now() {
  return new Date().toISOString()
}

function parseJson(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function ensureColumn(db, table, name, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name))
  if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
}

function backfillCandidatePhotoUrls(db) {
  const rows = db.prepare(`
    SELECT csr.candidate_id, csr.raw_payload
    FROM candidate_source_records csr
    JOIN candidates c ON c.id = csr.candidate_id
    WHERE csr.record_type = 'candidate' AND (c.photo_url IS NULL OR c.photo_url = '')
    ORDER BY csr.updated_at DESC, csr.id
  `).all()
  const update = db.prepare(`
    UPDATE candidates SET photo_url = ?, updated_at = ?
    WHERE id = ? AND (photo_url IS NULL OR photo_url = '')
  `)
  const completed = new Set()
  for (const row of rows) {
    if (completed.has(row.candidate_id)) continue
    let payload
    try {
      payload = JSON.parse(row.raw_payload)
    } catch {
      continue
    }
    const photoUrl = normalizePhotoUrl(payload?.['证件照'])
    if (!photoUrl) continue
    const result = update.run(photoUrl, now(), row.candidate_id)
    if (result.changes) {
      addActivity(db, row.candidate_id, 'candidate_photo_backfilled', '从既有北森来源记录补充证件照')
      completed.add(row.candidate_id)
    }
  }
}

function backfillCandidateDemographics(db) {
  const rows = db.prepare(`
    SELECT csr.candidate_id, csr.raw_payload
    FROM candidate_source_records csr
    JOIN candidates c ON c.id = csr.candidate_id
    WHERE csr.record_type = 'candidate'
      AND (
        c.gender IS NULL OR c.gender = '' OR
        c.birth_date IS NULL OR c.birth_date = '' OR
        c.age IS NULL
      )
    ORDER BY csr.updated_at DESC, csr.id
  `).all()
  const valuesByCandidate = new Map()
  for (const row of rows) {
    let payload
    try {
      payload = JSON.parse(row.raw_payload)
    } catch {
      continue
    }
    const current = valuesByCandidate.get(row.candidate_id) ?? {}
    if (!current.gender) current.gender = normalizeGender(payload?.['性别'] ?? payload?.gender)
    if (!current.birthDate) {
      current.birthDate = normalizeBirthDate(payload?.['出生日期'] ?? payload?.['生日'] ?? payload?.birth_date)
    }
    if (current.age == null) current.age = normalizeAge(payload?.['年龄'] ?? payload?.age)
    valuesByCandidate.set(row.candidate_id, current)
  }

  const update = db.prepare(`
    UPDATE candidates SET
      gender = CASE WHEN gender IS NULL OR gender = '' THEN ? ELSE gender END,
      birth_date = CASE WHEN birth_date IS NULL OR birth_date = '' THEN ? ELSE birth_date END,
      age = COALESCE(age, ?)
    WHERE id = ?
  `)
  for (const [candidateId, values] of valuesByCandidate) {
    if (!values.gender && !values.birthDate && values.age == null) continue
    update.run(values.gender ?? null, values.birthDate ?? null, values.age ?? null, candidateId)
  }
}

function migrateReadonlyAttachmentDatabase(db, { backfill = true } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidate_attachments (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      original_filename TEXT NOT NULL CHECK(length(original_filename) BETWEEN 1 AND 255),
      storage_path TEXT NOT NULL CHECK(length(storage_path) BETWEEN 1 AND 1000),
      mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 200),
      file_size INTEGER NOT NULL CHECK(file_size BETWEEN 1 AND 15728640),
      sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
      attachment_type TEXT NOT NULL DEFAULT 'resume',
      parse_status TEXT NOT NULL DEFAULT 'parsed'
        CHECK(parse_status IN ('pending', 'parsing', 'parsed', 'failed')),
      parser_version TEXT NOT NULL,
      extracted_text TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'user_upload',
      import_batch_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
      FOREIGN KEY(import_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
      UNIQUE(candidate_id, sha256, attachment_type)
    );
    CREATE INDEX IF NOT EXISTS candidate_attachments_candidate_idx
      ON candidate_attachments(candidate_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS candidate_attachments_sha_idx
      ON candidate_attachments(sha256);

    CREATE TABLE IF NOT EXISTS attachment_update_previews (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
      original_filename TEXT NOT NULL,
      quarantine_path TEXT,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL CHECK(file_size BETWEEN 1 AND 15728640),
      sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
      format TEXT NOT NULL,
      parse_status TEXT NOT NULL
        CHECK(parse_status IN ('parsing', 'parsed', 'failed', 'cancelled', 'confirmed', 'expired')),
      parser_version TEXT NOT NULL,
      extracted_text TEXT NOT NULL DEFAULT '',
      records_json TEXT NOT NULL DEFAULT '[]',
      requested_candidate_id TEXT,
      error_code TEXT,
      error_message TEXT,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(requested_candidate_id) REFERENCES candidates(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS attachment_update_previews_expiry_idx
      ON attachment_update_previews(parse_status, expires_at);

    CREATE TABLE IF NOT EXISTS candidate_field_sources (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      previous_value TEXT,
      new_value TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
      FOREIGN KEY(attachment_id) REFERENCES candidate_attachments(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS candidate_field_sources_candidate_idx
      ON candidate_field_sources(candidate_id, field_name, created_at DESC);

    CREATE TABLE IF NOT EXISTS attachment_cleanup_jobs (
      id TEXT PRIMARY KEY,
      storage_path TEXT NOT NULL,
      reason TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS attachment_cleanup_jobs_pending_path_unique
      ON attachment_cleanup_jobs(storage_path) WHERE completed_at IS NULL;
    CREATE INDEX IF NOT EXISTS attachment_cleanup_jobs_pending_idx
      ON attachment_cleanup_jobs(completed_at, updated_at);

    CREATE TABLE IF NOT EXISTS position_deletion_audits (
      id TEXT PRIMARY KEY,
      position_id_hash TEXT NOT NULL CHECK(length(position_id_hash) = 64),
      affected_candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(affected_candidate_count >= 0),
      deleted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS position_deletion_audits_deleted_at_idx
      ON position_deletion_audits(deleted_at DESC);

    CREATE TABLE IF NOT EXISTS agent_query_audits (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL CHECK(length(tool_name) BETWEEN 1 AND 100),
      query_scope TEXT NOT NULL DEFAULT '{}',
      duration_ms INTEGER NOT NULL DEFAULT 0 CHECK(duration_ms >= 0),
      row_count INTEGER NOT NULL DEFAULT 0 CHECK(row_count >= 0),
      error_code TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_query_audits_created_at_idx
      ON agent_query_audits(created_at DESC);

    CREATE TABLE IF NOT EXISTS candidate_resume_documents (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL UNIQUE,
      candidate_id TEXT NOT NULL,
      source_type TEXT NOT NULL
        CHECK(source_type IN ('candidate', 'profile_section', 'attachment')),
      source_id TEXT,
      title TEXT,
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS candidate_resume_documents_candidate_idx
      ON candidate_resume_documents(candidate_id, source_type, updated_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS candidate_resume_fts USING fts5(
      candidate_id UNINDEXED,
      document_id UNINDEXED,
      source_type UNINDEXED,
      title,
      content,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TABLE IF NOT EXISTS candidate_resume_vectors (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK(dimensions > 0),
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
      FOREIGN KEY(document_id) REFERENCES candidate_resume_documents(document_id) ON DELETE CASCADE,
      UNIQUE(document_id, chunk_index, provider, model)
    );
    CREATE INDEX IF NOT EXISTS candidate_resume_vectors_candidate_idx
      ON candidate_resume_vectors(candidate_id, document_id);

    CREATE TRIGGER IF NOT EXISTS candidate_resume_documents_ai
    AFTER INSERT ON candidate_resume_documents BEGIN
      INSERT INTO candidate_resume_fts(rowid, candidate_id, document_id, source_type, title, content)
      VALUES (NEW.row_id, NEW.candidate_id, NEW.document_id, NEW.source_type, NEW.title, NEW.content);
    END;
    CREATE TRIGGER IF NOT EXISTS candidate_resume_documents_au
    AFTER UPDATE ON candidate_resume_documents BEGIN
      DELETE FROM candidate_resume_fts WHERE rowid = OLD.row_id;
      INSERT INTO candidate_resume_fts(rowid, candidate_id, document_id, source_type, title, content)
      VALUES (NEW.row_id, NEW.candidate_id, NEW.document_id, NEW.source_type, NEW.title, NEW.content);
    END;
    CREATE TRIGGER IF NOT EXISTS candidate_resume_documents_ad
    AFTER DELETE ON candidate_resume_documents BEGIN
      DELETE FROM candidate_resume_fts WHERE rowid = OLD.row_id;
    END;

    CREATE TRIGGER IF NOT EXISTS candidates_resume_ai
    AFTER INSERT ON candidates BEGIN
      INSERT INTO candidate_resume_documents(
        document_id, candidate_id, source_type, source_id, title, content, created_at, updated_at
      ) VALUES (
        'candidate:' || NEW.id,
        NEW.id,
        'candidate',
        NEW.id,
        '候选人主档',
        trim(
          coalesce(NEW.name, '') || ' ' || coalesce(NEW.current_company, '') || ' ' ||
          coalesce(NEW.current_title, '') || ' ' || coalesce(NEW.location, '') || ' ' ||
          coalesce(NEW.education, '') || ' ' || coalesce(NEW.highest_school, '') || ' ' ||
          coalesce(NEW.highest_major, '') || ' ' || coalesce(NEW.self_summary, '') || ' ' ||
          coalesce(NEW.tags, '')
        ),
        NEW.created_at,
        NEW.updated_at
      ) ON CONFLICT(document_id) DO UPDATE SET
        content = excluded.content,
        updated_at = excluded.updated_at;
    END;
    CREATE TRIGGER IF NOT EXISTS candidates_resume_au
    AFTER UPDATE ON candidates BEGIN
      INSERT INTO candidate_resume_documents(
        document_id, candidate_id, source_type, source_id, title, content, created_at, updated_at
      ) VALUES (
        'candidate:' || NEW.id,
        NEW.id,
        'candidate',
        NEW.id,
        '候选人主档',
        trim(
          coalesce(NEW.name, '') || ' ' || coalesce(NEW.current_company, '') || ' ' ||
          coalesce(NEW.current_title, '') || ' ' || coalesce(NEW.location, '') || ' ' ||
          coalesce(NEW.education, '') || ' ' || coalesce(NEW.highest_school, '') || ' ' ||
          coalesce(NEW.highest_major, '') || ' ' || coalesce(NEW.self_summary, '') || ' ' ||
          coalesce(NEW.tags, '')
        ),
        NEW.created_at,
        NEW.updated_at
      ) ON CONFLICT(document_id) DO UPDATE SET
        content = excluded.content,
        updated_at = excluded.updated_at;
    END;

    CREATE TRIGGER IF NOT EXISTS candidate_profile_sections_resume_ai
    AFTER INSERT ON candidate_profile_sections
    WHEN NEW.archived_at IS NULL BEGIN
      INSERT INTO candidate_resume_documents(
        document_id, candidate_id, source_type, source_id, title, content, created_at, updated_at
      ) VALUES (
        'section:' || NEW.id,
        NEW.candidate_id,
        'profile_section',
        NEW.id,
        coalesce(NEW.title, NEW.section_type),
        trim(coalesce(NEW.title, '') || ' ' || coalesce(NEW.content, '') || ' ' || coalesce(NEW.structured_data, '')),
        NEW.created_at,
        NEW.updated_at
      ) ON CONFLICT(document_id) DO UPDATE SET
        candidate_id = excluded.candidate_id,
        title = excluded.title,
        content = excluded.content,
        updated_at = excluded.updated_at;
    END;
    CREATE TRIGGER IF NOT EXISTS candidate_profile_sections_resume_au
    AFTER UPDATE ON candidate_profile_sections BEGIN
      DELETE FROM candidate_resume_documents WHERE document_id = 'section:' || OLD.id;
      INSERT INTO candidate_resume_documents(
        document_id, candidate_id, source_type, source_id, title, content, created_at, updated_at
      )
      SELECT
        'section:' || NEW.id,
        NEW.candidate_id,
        'profile_section',
        NEW.id,
        coalesce(NEW.title, NEW.section_type),
        trim(coalesce(NEW.title, '') || ' ' || coalesce(NEW.content, '') || ' ' || coalesce(NEW.structured_data, '')),
        NEW.created_at,
        NEW.updated_at
      WHERE NEW.archived_at IS NULL;
    END;
    CREATE TRIGGER IF NOT EXISTS candidate_profile_sections_resume_ad
    AFTER DELETE ON candidate_profile_sections BEGIN
      DELETE FROM candidate_resume_documents WHERE document_id = 'section:' || OLD.id;
    END;

    CREATE TRIGGER IF NOT EXISTS candidate_attachments_resume_ai
    AFTER INSERT ON candidate_attachments
    WHEN NEW.parse_status = 'parsed' AND NEW.extracted_text <> '' BEGIN
      INSERT INTO candidate_resume_documents(
        document_id, candidate_id, source_type, source_id, title, content, created_at, updated_at
      ) VALUES (
        'attachment:' || NEW.id,
        NEW.candidate_id,
        'attachment',
        NEW.id,
        NEW.original_filename,
        NEW.extracted_text,
        NEW.created_at,
        NEW.updated_at
      ) ON CONFLICT(document_id) DO UPDATE SET
        candidate_id = excluded.candidate_id,
        title = excluded.title,
        content = excluded.content,
        updated_at = excluded.updated_at;
    END;
    CREATE TRIGGER IF NOT EXISTS candidate_attachments_resume_au
    AFTER UPDATE ON candidate_attachments BEGIN
      DELETE FROM candidate_resume_documents WHERE document_id = 'attachment:' || OLD.id;
      INSERT INTO candidate_resume_documents(
        document_id, candidate_id, source_type, source_id, title, content, created_at, updated_at
      )
      SELECT
        'attachment:' || NEW.id,
        NEW.candidate_id,
        'attachment',
        NEW.id,
        NEW.original_filename,
        NEW.extracted_text,
        NEW.created_at,
        NEW.updated_at
      WHERE NEW.parse_status = 'parsed' AND NEW.extracted_text <> '';
    END;
    CREATE TRIGGER IF NOT EXISTS candidate_attachments_resume_ad
    AFTER DELETE ON candidate_attachments BEGIN
      DELETE FROM candidate_resume_documents WHERE document_id = 'attachment:' || OLD.id;
    END;
  `)

  // V6's source-to-resume backfill is one-time; triggers keep it current.
  if (!backfill) return

  const timestamp = now()
  db.prepare(`
    INSERT INTO candidate_resume_documents(
      document_id, candidate_id, source_type, source_id, title, content, created_at, updated_at
    )
    SELECT
      'candidate:' || c.id,
      c.id,
      'candidate',
      c.id,
      '候选人主档',
      trim(
        coalesce(c.name, '') || ' ' || coalesce(c.current_company, '') || ' ' ||
        coalesce(c.current_title, '') || ' ' || coalesce(c.location, '') || ' ' ||
        coalesce(c.education, '') || ' ' || coalesce(c.highest_school, '') || ' ' ||
        coalesce(c.highest_major, '') || ' ' || coalesce(c.self_summary, '') || ' ' ||
        coalesce(c.tags, '')
      ),
      c.created_at,
      c.updated_at
    FROM candidates c
    WHERE 1
    ON CONFLICT(document_id) DO UPDATE SET
      content = excluded.content,
      updated_at = excluded.updated_at
  `).run()
  db.prepare(`
    INSERT INTO candidate_resume_documents(
      document_id, candidate_id, source_type, source_id, title, content, created_at, updated_at
    )
    SELECT
      'section:' || s.id,
      s.candidate_id,
      'profile_section',
      s.id,
      coalesce(s.title, s.section_type),
      trim(coalesce(s.title, '') || ' ' || coalesce(s.content, '') || ' ' || coalesce(s.structured_data, '')),
      s.created_at,
      s.updated_at
    FROM candidate_profile_sections s
    WHERE s.archived_at IS NULL
    ON CONFLICT(document_id) DO UPDATE SET
      candidate_id = excluded.candidate_id,
      title = excluded.title,
      content = excluded.content,
      updated_at = excluded.updated_at
  `).run()
  db.prepare(`
    INSERT INTO candidate_resume_documents(
      document_id, candidate_id, source_type, source_id, title, content, created_at, updated_at
    )
    SELECT
      'attachment:' || a.id,
      a.candidate_id,
      'attachment',
      a.id,
      a.original_filename,
      a.extracted_text,
      a.created_at,
      a.updated_at
    FROM candidate_attachments a
    WHERE a.parse_status = 'parsed' AND a.extracted_text <> ''
    ON CONFLICT(document_id) DO UPDATE SET
      candidate_id = excluded.candidate_id,
      title = excluded.title,
      content = excluded.content,
      updated_at = excluded.updated_at
  `).run()
  db.prepare(`
    INSERT INTO schema_migrations(version, name, applied_at)
    VALUES (6, 'readonly_agent_attachments_fts_deletion', ?)
    ON CONFLICT(version) DO NOTHING
  `).run(timestamp)
}

function migrateAgentSessionDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '新对话' CHECK(length(title) BETWEEN 1 AND 200),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
      next_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence >= 1),
      active_request_id TEXT,
      active_request_started_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_sessions_updated_idx
      ON agent_sessions(status, updated_at DESC, id);

    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence >= 1),
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL CHECK(length(content) <= 120000),
      status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
      client_request_id TEXT CHECK(client_request_id IS NULL OR length(client_request_id) BETWEEN 1 AND 200),
      request_hash TEXT CHECK(request_hash IS NULL OR length(request_hash) = 64),
      reply_to_message_id TEXT,
      model TEXT,
      tools_used_json TEXT NOT NULL DEFAULT '[]',
      error_code TEXT,
      input_bytes INTEGER CHECK(input_bytes IS NULL OR input_bytes >= 0),
      output_bytes INTEGER CHECK(output_bytes IS NULL OR output_bytes >= 0),
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY(session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(reply_to_message_id) REFERENCES agent_messages(id) ON DELETE SET NULL,
      UNIQUE(session_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS agent_messages_session_idx
      ON agent_messages(session_id, sequence DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS agent_messages_request_unique
      ON agent_messages(client_request_id) WHERE client_request_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS agent_messages_reply_unique
      ON agent_messages(reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS agent_session_summaries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      through_sequence INTEGER NOT NULL CHECK(through_sequence >= 1),
      summary_text TEXT NOT NULL CHECK(length(summary_text) BETWEEN 1 AND 16000),
      source_message_count INTEGER NOT NULL CHECK(source_message_count >= 1),
      model TEXT,
      prompt_version INTEGER NOT NULL DEFAULT 1 CHECK(prompt_version >= 1),
      input_bytes INTEGER NOT NULL DEFAULT 0 CHECK(input_bytes >= 0),
      created_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
      UNIQUE(session_id, through_sequence)
    );
    CREATE INDEX IF NOT EXISTS agent_session_summaries_latest_idx
      ON agent_session_summaries(session_id, through_sequence DESC);
  `)
}

function migrateV8Database(db) {
  migrateAgentSessionDatabase(db)
  migrateBusinessSearch(db)
  db.exec(`
    CREATE INDEX IF NOT EXISTS candidates_archived_updated_v8_idx
      ON candidates(archived_at, updated_at DESC, id);
    CREATE INDEX IF NOT EXISTS candidates_gender_archived_updated_v8_idx
      ON candidates(gender, archived_at, updated_at DESC, id);
    CREATE INDEX IF NOT EXISTS positions_archived_updated_v8_idx
      ON positions(archived_at, updated_at DESC, id);
    CREATE INDEX IF NOT EXISTS talent_pools_archived_updated_v8_idx
      ON talent_pools(archived_at, updated_at DESC, id);
    CREATE INDEX IF NOT EXISTS candidate_positions_position_candidate_v8_idx
      ON candidate_positions(position_id, candidate_id);
    CREATE INDEX IF NOT EXISTS candidate_talent_pools_pool_candidate_v8_idx
      ON candidate_talent_pools(talent_pool_id, candidate_id);
  `)
  db.prepare(`
    INSERT INTO schema_migrations(version, name, applied_at)
    VALUES (8, 'agent_sessions_and_full_business_search', ?)
    ON CONFLICT(version) DO UPDATE SET name = excluded.name
  `).run(now())
}

export function migrateV9Database(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL UNIQUE,
      client_request_id TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'planning', 'querying', 'retrieving', 'composing',
        'completed', 'partial', 'failed', 'cancelled'
      )),
      stage TEXT NOT NULL,
      result_json TEXT,
      result_bytes INTEGER NOT NULL DEFAULT 0 CHECK(result_bytes >= 0),
      result_count INTEGER NOT NULL DEFAULT 0 CHECK(result_count >= 0),
      has_more INTEGER NOT NULL DEFAULT 0 CHECK(has_more IN (0, 1)),
      timings_json TEXT NOT NULL DEFAULT '{}',
      tools_used_json TEXT NOT NULL DEFAULT '[]',
      error_code TEXT,
      error_stage TEXT,
      error_message TEXT,
      retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0, 1)),
      cancel_requested_at TEXT,
      heartbeat_at TEXT,
      deadline_at TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY(session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(user_message_id) REFERENCES agent_messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS agent_tasks_session_status_idx
      ON agent_tasks(session_id, status, updated_at DESC, id);
    CREATE INDEX IF NOT EXISTS agent_tasks_heartbeat_idx
      ON agent_tasks(status, heartbeat_at);
    CREATE INDEX IF NOT EXISTS agent_tasks_created_idx
      ON agent_tasks(created_at DESC, id);
  `)
  ensureColumn(db, 'agent_query_audits', 'trace_id', 'TEXT')
  ensureColumn(db, 'agent_query_audits', 'task_id', 'TEXT')
  ensureColumn(db, 'agent_query_audits', 'phase', 'TEXT')
  db.exec(`
    CREATE INDEX IF NOT EXISTS agent_query_audits_task_idx
      ON agent_query_audits(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS candidates_stage_id_v9_idx
      ON candidates(stage, id);
    CREATE INDEX IF NOT EXISTS candidates_import_batch_id_v9_idx
      ON candidates(import_batch_id, id);
  `)
  db.prepare(`
    INSERT INTO schema_migrations(version, name, applied_at)
    VALUES (9, 'agent_async_tasks_and_phase_audits', ?)
    ON CONFLICT(version) DO UPDATE SET name = excluded.name
  `).run(now())
}

export function migrateV10Database(db) {
  migrateAttachmentBatchDatabase(db)
  db.exec(`
    CREATE INDEX IF NOT EXISTS candidates_stage_archived_id_v10_idx
      ON candidates(stage, archived_at, id);
    CREATE INDEX IF NOT EXISTS candidates_archived_source_v10_idx
      ON candidates(archived_at, source);
    CREATE INDEX IF NOT EXISTS candidates_archived_education_v10_idx
      ON candidates(archived_at, education);
    CREATE INDEX IF NOT EXISTS candidates_archived_job_status_v10_idx
      ON candidates(archived_at, job_seeking_status);
  `)
  db.prepare(`
    INSERT INTO schema_migrations(version, name, applied_at)
    VALUES (10, 'durable_attachment_import_batches', ?)
    ON CONFLICT(version) DO UPDATE SET name = excluded.name
  `).run(now())
}

export function migrateV11Database(db) {
  ensureColumn(db, 'candidates', 'hire_status', 'TEXT')
  ensureColumn(db, 'candidates', 'hire_date', 'TEXT')
  db.exec(`
    CREATE INDEX IF NOT EXISTS candidates_hire_status_idx
      ON candidates(hire_status);
    CREATE INDEX IF NOT EXISTS candidates_hire_date_idx
      ON candidates(hire_date);
  `)
  db.prepare(`
    INSERT INTO schema_migrations(version, name, applied_at)
    VALUES (11, 'candidate_hire_status_and_date', ?)
    ON CONFLICT(version) DO UPDATE SET name = excluded.name
  `).run(now())
}

function migrateTalentDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)

  const v6PreviouslyApplied = Boolean(db.prepare(
    'SELECT 1 FROM schema_migrations WHERE version = 6'
  ).get())
  const v8PreviouslyApplied = Boolean(db.prepare(
    'SELECT 1 FROM schema_migrations WHERE version = 8'
  ).get())

  db.exec('BEGIN IMMEDIATE')
  try {
    ensureColumn(db, 'candidates', 'highest_school', 'TEXT')
    ensureColumn(db, 'candidates', 'highest_major', 'TEXT')
    ensureColumn(db, 'candidates', 'job_seeking_status', 'TEXT')
    ensureColumn(db, 'candidates', 'resume_updated_at', 'TEXT')
    ensureColumn(db, 'candidates', 'self_summary', 'TEXT')
    ensureColumn(db, 'candidates', 'photo_url', 'TEXT')
    ensureColumn(db, 'candidates', 'gender', 'TEXT')
    ensureColumn(db, 'candidates', 'birth_date', 'TEXT')
    ensureColumn(db, 'candidates', 'age', 'INTEGER')
    ensureColumn(db, 'candidates', 'hire_status', 'TEXT')
    ensureColumn(db, 'candidates', 'hire_date', 'TEXT')

    for (const [name, definition] of [
      ['source_system', 'TEXT'],
      ['source_record_id', 'TEXT'],
      ['external_code', 'TEXT'],
      ['category', 'TEXT'],
      ['professional_line', 'TEXT'],
      ['job_sequence', 'TEXT'],
      ['headcount_type', 'TEXT'],
      ['project_name', 'TEXT']
    ]) ensureColumn(db, 'positions', name, definition)

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS positions_source_record_unique
        ON positions(source_system, source_record_id)
        WHERE source_system IS NOT NULL AND source_system <> ''
          AND source_record_id IS NOT NULL AND source_record_id <> '';
      CREATE UNIQUE INDEX IF NOT EXISTS positions_external_code_unique
        ON positions(source_system, external_code)
        WHERE source_system IS NOT NULL AND source_system <> ''
          AND external_code IS NOT NULL AND external_code <> '';
      CREATE INDEX IF NOT EXISTS candidates_education_idx ON candidates(education);
      CREATE INDEX IF NOT EXISTS candidates_highest_school_idx ON candidates(highest_school);
      CREATE INDEX IF NOT EXISTS candidates_highest_major_idx ON candidates(highest_major);
      CREATE INDEX IF NOT EXISTS candidates_job_seeking_status_idx ON candidates(job_seeking_status);
      CREATE INDEX IF NOT EXISTS candidates_gender_idx ON candidates(gender);

      CREATE TABLE IF NOT EXISTS talent_pools (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE CHECK(length(name) BETWEEN 1 AND 200),
        description TEXT,
        color TEXT NOT NULL DEFAULT '#2563eb',
        source_system TEXT,
        source_record_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS talent_pools_name_unique ON talent_pools(name);
      CREATE UNIQUE INDEX IF NOT EXISTS talent_pools_source_record_unique
        ON talent_pools(source_system, source_record_id)
        WHERE source_system IS NOT NULL AND source_system <> ''
          AND source_record_id IS NOT NULL AND source_record_id <> '';
      CREATE INDEX IF NOT EXISTS talent_pools_updated_idx ON talent_pools(updated_at DESC);

      CREATE TABLE IF NOT EXISTS candidate_talent_pools (
        candidate_id TEXT NOT NULL,
        talent_pool_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(candidate_id, talent_pool_id),
        FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
        FOREIGN KEY(talent_pool_id) REFERENCES talent_pools(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS candidate_talent_pools_pool_idx
        ON candidate_talent_pools(talent_pool_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS candidate_profile_sections (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        section_type TEXT NOT NULL CHECK(length(section_type) BETWEEN 1 AND 80),
        title TEXT,
        content TEXT,
        structured_data TEXT NOT NULL DEFAULT '{}',
        sort_order INTEGER NOT NULL DEFAULT 0,
        sensitivity TEXT NOT NULL DEFAULT 'internal'
          CHECK(sensitivity IN ('public', 'internal', 'high')),
        source_record_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS candidate_profile_sections_candidate_idx
        ON candidate_profile_sections(candidate_id, section_type, sort_order);

      CREATE TABLE IF NOT EXISTS candidate_preferences (
        candidate_id TEXT PRIMARY KEY,
        employment_status TEXT,
        desired_titles TEXT NOT NULL DEFAULT '[]',
        desired_locations TEXT NOT NULL DEFAULT '[]',
        employment_type TEXT,
        expected_salary TEXT,
        availability TEXT,
        raw_payload TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS candidate_source_records (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        source_system TEXT NOT NULL,
        source_record_id TEXT NOT NULL,
        record_type TEXT NOT NULL DEFAULT 'candidate',
        source_name TEXT,
        source_timestamp TEXT,
        raw_payload TEXT NOT NULL DEFAULT '{}',
        sensitivity TEXT NOT NULL DEFAULT 'high'
          CHECK(sensitivity IN ('public', 'internal', 'high')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
        UNIQUE(source_system, source_record_id, record_type)
      );
      CREATE INDEX IF NOT EXISTS candidate_source_records_candidate_idx
        ON candidate_source_records(candidate_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS candidate_assessments (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        position_id TEXT,
        assessment_type TEXT NOT NULL,
        title TEXT,
        status TEXT,
        score TEXT,
        conclusion TEXT,
        occurred_at TEXT,
        source_system TEXT,
        source_record_id TEXT,
        raw_payload TEXT NOT NULL DEFAULT '{}',
        sensitivity TEXT NOT NULL DEFAULT 'high'
          CHECK(sensitivity IN ('public', 'internal', 'high')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
        FOREIGN KEY(position_id) REFERENCES positions(id) ON DELETE SET NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS candidate_assessments_source_unique
        ON candidate_assessments(source_system, source_record_id, assessment_type)
        WHERE source_system IS NOT NULL AND source_record_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS candidate_assessments_candidate_idx
        ON candidate_assessments(candidate_id, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS candidate_consents (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        consent_type TEXT NOT NULL,
        status TEXT,
        agreement_name TEXT,
        consented_at TEXT,
        expires_at TEXT,
        source_system TEXT,
        source_record_id TEXT,
        raw_payload TEXT NOT NULL DEFAULT '{}',
        sensitivity TEXT NOT NULL DEFAULT 'high'
          CHECK(sensitivity IN ('public', 'internal', 'high')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS candidate_consents_source_unique
        ON candidate_consents(source_system, source_record_id, consent_type)
        WHERE source_system IS NOT NULL AND source_record_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS candidate_consents_candidate_idx
        ON candidate_consents(candidate_id, consented_at DESC);

      CREATE TABLE IF NOT EXISTS candidate_position_sources (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        position_id TEXT NOT NULL,
        source_system TEXT NOT NULL,
        source_application_id TEXT NOT NULL,
        applied_at TEXT,
        raw_payload TEXT NOT NULL DEFAULT '{}',
        sensitivity TEXT NOT NULL DEFAULT 'high'
          CHECK(sensitivity IN ('public', 'internal', 'high')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
        FOREIGN KEY(position_id) REFERENCES positions(id) ON DELETE CASCADE,
        UNIQUE(source_system, source_application_id)
      );
      CREATE INDEX IF NOT EXISTS candidate_position_sources_candidate_idx
        ON candidate_position_sources(candidate_id, applied_at DESC);
      CREATE INDEX IF NOT EXISTS candidate_position_sources_position_idx
        ON candidate_position_sources(position_id, applied_at DESC);

      CREATE TABLE IF NOT EXISTS deletion_audits (
        id TEXT PRIMARY KEY,
        candidate_id_hash TEXT NOT NULL CHECK(length(candidate_id_hash) = 64),
        deleted_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS deletion_audits_deleted_at_idx
        ON deletion_audits(deleted_at DESC);
    `)

    const recordMigration = db.prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)
    `)
    recordMigration.run(1, 'candidate_workbench_baseline', now())
    recordMigration.run(2, 'talent_library_domain', now())
    recordMigration.run(3, 'candidate_photo_avatar', now())
    const photoBackfillApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = 4').get()
    if (!photoBackfillApplied) backfillCandidatePhotoUrls(db)
    recordMigration.run(4, 'candidate_photo_backfill', now())
    recordMigration.run(5, 'candidate_deletion_audits', now())
    migrateReadonlyAttachmentDatabase(db, { backfill: !v6PreviouslyApplied })
    const demographicsApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = 7').get()
    if (!demographicsApplied) backfillCandidateDemographics(db)
    recordMigration.run(7, 'candidate_demographics_and_large_import', now())
    migrateV8Database(db)
    migrateV9Database(db)
    migrateV10Database(db)
    migrateV11Database(db)
    db.exec('COMMIT')
    return { v8PreviouslyApplied, v9Applied: true, v10Applied: true }
  } catch (error) {
    db.exec('ROLLBACK')
    if (/no such module:\s*fts5/i.test(String(error?.message ?? ''))) {
      throw new Error('当前 SQLite 构建不支持 FTS5，无法启用候选人履历全文检索', { cause: error })
    }
    throw error
  }
}

export function serializeCandidate(row) {
  if (!row) return null
  return {
    ...row,
    has_photo: Boolean(row.photo_url),
    age: row.age == null ? null : Number(row.age),
    years_experience: row.years_experience == null ? null : Number(row.years_experience),
    tags: parseJson(row.tags, [])
  }
}

export function serializeActivity(row) {
  if (!row) return null
  return { ...row, metadata: parseJson(row.metadata, {}) }
}

export function serializePosition(row) {
  if (!row) return null
  return {
    ...row,
    headcount: Number(row.headcount),
    candidate_count: row.candidate_count == null ? undefined : Number(row.candidate_count),
    tags: parseJson(row.tags, [])
  }
}

function safeRelatedRow(row, { includeSensitive = false, jsonFields = [] } = {}) {
  const result = { ...row }
  for (const field of jsonFields) result[field] = parseJson(result[field], field.endsWith('s') ? [] : {})
  if (includeSensitive && Object.prototype.hasOwnProperty.call(result, 'raw_payload')) {
    result.raw_payload = parseJson(result.raw_payload, {})
  } else {
    delete result.raw_payload
  }
  return result
}

export function openDatabase(databasePath = configuredDatabasePath(), { synchronizeSearch = true } = {}) {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true })

  const db = new DatabaseSync(databasePath)
  transactionSearchPolicy.set(db, synchronizeSearch ? 'bounded' : 'background')
  // Business-search synchronization can infer whether it is running on the
  // request connection.  File-backed services defer an empty/full backfill to
  // the dedicated maintenance worker; in-memory fixtures retain eager sync.
  db.__candidateWorkbenchSearchPolicy = synchronizeSearch ? 'bounded' : 'background'
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  if (databasePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS stages (
      value TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      color TEXT NOT NULL,
      position INTEGER NOT NULL,
      is_terminal INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      photo_url TEXT,
      current_company TEXT,
      current_title TEXT,
      location TEXT,
      gender TEXT,
      birth_date TEXT,
      age INTEGER,
      years_experience REAL,
      education TEXT,
      hire_status TEXT,
      hire_date TEXT,
      source TEXT,
      stage TEXT NOT NULL DEFAULT '新候选人',
      owner TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      expected_salary TEXT,
      source_system TEXT,
      source_record_id TEXT,
      import_batch_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      FOREIGN KEY(stage) REFERENCES stages(value)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS candidates_source_record_unique
      ON candidates(source_system, source_record_id)
      WHERE source_system IS NOT NULL AND source_system <> ''
        AND source_record_id IS NOT NULL AND source_record_id <> '';
    CREATE INDEX IF NOT EXISTS candidates_email_idx ON candidates(email);
    CREATE INDEX IF NOT EXISTS candidates_phone_idx ON candidates(phone);
    CREATE INDEX IF NOT EXISTS candidates_stage_idx ON candidates(stage);
    CREATE INDEX IF NOT EXISTS candidates_updated_idx ON candidates(updated_at DESC);

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      content TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '当前用户',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS notes_candidate_idx ON notes(candidate_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS activities_candidate_idx ON activities(candidate_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      sheet_name TEXT,
      total_rows INTEGER NOT NULL,
      imported_rows INTEGER NOT NULL DEFAULT 0,
      updated_rows INTEGER NOT NULL DEFAULT 0,
      skipped_rows INTEGER NOT NULL DEFAULT 0,
      failed_rows INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
      department TEXT,
      location TEXT,
      owner TEXT,
      headcount INTEGER NOT NULL DEFAULT 1 CHECK(headcount BETWEEN 1 AND 10000),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'open', 'paused', 'closed')),
      description TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE INDEX IF NOT EXISTS positions_status_idx ON positions(status);
    CREATE INDEX IF NOT EXISTS positions_department_idx ON positions(department);
    CREATE INDEX IF NOT EXISTS positions_owner_idx ON positions(owner);
    CREATE INDEX IF NOT EXISTS positions_updated_idx ON positions(updated_at DESC);

    CREATE TABLE IF NOT EXISTS candidate_positions (
      candidate_id TEXT NOT NULL,
      position_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(candidate_id, position_id),
      FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
      FOREIGN KEY(position_id) REFERENCES positions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS candidate_positions_position_idx
      ON candidate_positions(position_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS candidate_positions_candidate_idx
      ON candidate_positions(candidate_id, created_at DESC);
  `)

  const noteColumns = new Set(db.prepare('PRAGMA table_info(notes)').all().map((column) => column.name))
  if (!noteColumns.has('author')) {
    db.exec("ALTER TABLE notes ADD COLUMN author TEXT NOT NULL DEFAULT '当前用户'")
  }

  const migrationState = migrateTalentDatabase(db)

  const stageStatement = db.prepare(`
    INSERT INTO stages(value, label, color, position, is_terminal)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(value) DO UPDATE SET
      label = excluded.label,
      color = excluded.color,
      position = excluded.position,
      is_terminal = excluded.is_terminal
    WHERE stages.label IS NOT excluded.label
       OR stages.color IS NOT excluded.color
       OR stages.position IS NOT excluded.position
       OR stages.is_terminal IS NOT excluded.is_terminal
  `)
  for (const stage of DEFAULT_STAGES) {
    stageStatement.run(stage.value, stage.label, stage.color, stage.position, stage.terminal ? 1 : 0)
  }

  if (synchronizeSearch) {
    synchronizeBusinessSearch(db, { forceBackfill: !migrationState.v8PreviouslyApplied })
  }

  return db
}

export function listStages(db) {
  return db.prepare(`
    SELECT value, label, color, position, is_terminal
    FROM stages
    ORDER BY position ASC
  `).all().map((stage) => ({ ...stage, is_terminal: Boolean(stage.is_terminal) }))
}

export function getCandidate(db, id, {
  includeRelated = true,
  includeSensitive = true,
  includeLegacyStage = true
} = {}) {
  const candidate = serializeCandidate(db.prepare('SELECT * FROM candidates WHERE id = ?').get(id))
  if (!candidate) return null
  if (!includeRelated) {
    const result = { ...candidate }
    if (!includeSensitive) {
      delete result.phone
      delete result.email
      delete result.expected_salary
      delete result.photo_url
    }
    if (!includeLegacyStage) delete result.stage
    return result
  }

  const notes = db.prepare(`
    SELECT id, candidate_id, content, author, created_at, updated_at
    FROM notes WHERE candidate_id = ? ORDER BY created_at DESC
  `).all(id)
  const activities = db.prepare(`
    SELECT id, candidate_id, type, description, metadata, created_at
    FROM activities WHERE candidate_id = ? ORDER BY created_at DESC
  `).all(id).map(serializeActivity)
  const positions = db.prepare(`
    SELECT p.*, cp.created_at AS linked_at,
      (SELECT COUNT(*) FROM candidate_positions count_cp WHERE count_cp.position_id = p.id) AS candidate_count
    FROM candidate_positions cp
    JOIN positions p ON p.id = cp.position_id
    WHERE cp.candidate_id = ?
    ORDER BY p.archived_at IS NOT NULL ASC, p.updated_at DESC, p.title ASC
  `).all(id).map(serializePosition)
  const talentPools = db.prepare(`
    SELECT tp.*, ctp.created_at AS linked_at
    FROM candidate_talent_pools ctp
    JOIN talent_pools tp ON tp.id = ctp.talent_pool_id
    WHERE ctp.candidate_id = ?
    ORDER BY tp.archived_at IS NOT NULL, tp.name COLLATE NOCASE
  `).all(id)
  const profileSections = db.prepare(`
    SELECT * FROM candidate_profile_sections
    WHERE candidate_id = ? AND archived_at IS NULL
    ORDER BY sort_order, created_at, id
  `).all(id).map((row) => safeRelatedRow(row, {
    includeSensitive: includeSensitive || row.sensitivity !== 'high',
    jsonFields: ['structured_data']
  })).filter((row) => includeSensitive || row.sensitivity !== 'high')
  const preferenceRow = db.prepare('SELECT * FROM candidate_preferences WHERE candidate_id = ?').get(id)
  const preferences = preferenceRow
    ? safeRelatedRow(preferenceRow, { includeSensitive, jsonFields: ['desired_titles', 'desired_locations'] })
    : null
  if (preferences && !includeSensitive) delete preferences.expected_salary
  const sourceRecords = db.prepare(`
    SELECT * FROM candidate_source_records WHERE candidate_id = ? ORDER BY created_at DESC, id
  `).all(id).map((row) => ({
    ...safeRelatedRow(row, { includeSensitive }),
    raw_payload_available: Boolean(row.raw_payload)
  }))
  const assessments = db.prepare(`
    SELECT * FROM candidate_assessments WHERE candidate_id = ? ORDER BY occurred_at DESC, created_at DESC, id
  `).all(id).map((row) => {
    const result = {
      ...safeRelatedRow(row, { includeSensitive }),
      raw_payload_available: Boolean(row.raw_payload)
    }
    if (!includeSensitive && row.sensitivity === 'high') {
      for (const field of ['title', 'status', 'score', 'conclusion']) delete result[field]
    }
    return result
  })
  const consents = db.prepare(`
    SELECT * FROM candidate_consents WHERE candidate_id = ? ORDER BY consented_at DESC, created_at DESC, id
  `).all(id).map((row) => {
    const result = {
      ...safeRelatedRow(row, { includeSensitive }),
      raw_payload_available: Boolean(row.raw_payload)
    }
    if (!includeSensitive && row.sensitivity === 'high') {
      for (const field of ['status', 'agreement_name', 'consented_at', 'expires_at']) delete result[field]
    }
    return result
  })
  const positionSources = db.prepare(`
    SELECT cps.*, p.title AS position_title
    FROM candidate_position_sources cps
    JOIN positions p ON p.id = cps.position_id
    WHERE cps.candidate_id = ?
    ORDER BY cps.applied_at DESC, cps.created_at DESC, cps.id
  `).all(id).map((row) => ({
    ...safeRelatedRow(row, { includeSensitive }),
    raw_payload_available: Boolean(row.raw_payload)
  }))
  const result = {
    ...candidate,
    notes,
    activities,
    positions,
    talent_pools: talentPools,
    profile_sections: profileSections,
    preferences,
    source_records: sourceRecords,
    assessments,
    consents,
    position_sources: positionSources
  }
  if (!includeSensitive) {
    delete result.phone
    delete result.email
    delete result.expected_salary
    delete result.photo_url
  }
  if (!includeLegacyStage) delete result.stage
  return result
}

export function findDuplicate(db, candidate, excludeId = null) {
  const statements = duplicateStatements(db)
  const matches = new Map()
  const addMatch = (row, matchedBy) => {
    if (!row) return
    const existing = matches.get(row.id)
    if (existing) {
      existing.matched_fields.push(matchedBy)
      return
    }
    matches.set(row.id, { ...row, matched_fields: [matchedBy] })
  }
  const query = (column, value, matchedBy) => {
    if (!value) return
    const statement = excludeId ? statements[`${column}Excluding`] : statements[column]
    const rows = excludeId ? statement.all(value, excludeId) : statement.all(value)
    for (const row of rows) addMatch(row, matchedBy)
  }

  if (candidate.source_system && candidate.source_record_id) {
    const rows = excludeId
      ? statements.sourceExcluding.all(candidate.source_system, candidate.source_record_id, excludeId)
      : statements.source.all(candidate.source_system, candidate.source_record_id)
    for (const row of rows) addMatch(row, 'source_record')
  }

  query('email', candidate.email, 'email')
  query('phone', candidate.phone, 'phone')

  const uniqueMatches = [...matches.values()]
  if (uniqueMatches.length === 0) return null
  if (uniqueMatches.length > 1) {
    return {
      identity_conflict: true,
      matched_by: 'identity_conflict',
      matches: uniqueMatches
    }
  }

  const [match] = uniqueMatches
  return {
    ...match,
    matched_by: match.matched_fields[0]
  }
}

export function addActivity(db, candidateId, type, description, metadata = {}) {
  const activity = {
    id: randomUUID(),
    candidate_id: candidateId,
    type,
    description,
    metadata,
    created_at: now()
  }
  activityInsertStatement(db).run(
    activity.id,
    activity.candidate_id,
    activity.type,
    activity.description,
    JSON.stringify(activity.metadata),
    activity.created_at
  )
  return activity
}

export function withTransaction(db, callback, {
  synchronizeSearch,
  searchBatchSize = 100,
  searchMaxBatches = 1
} = {}) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = callback()
    const shouldSynchronize = synchronizeSearch ?? transactionSearchPolicy.get(db) !== 'background'
    if (shouldSynchronize) {
      synchronizeBusinessSearch(db, {
        batchSize: searchBatchSize,
        maxBatches: searchMaxBatches
      })
    }
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export { now }
