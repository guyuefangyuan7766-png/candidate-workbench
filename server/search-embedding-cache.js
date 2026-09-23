import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const hash = value => createHash('sha256').update(value).digest('hex')
const fail = () => { const error = new Error('Embedding cache is invalid or belongs to a different space'); error.code = 'search_vector_cache_invalid'; throw error }
export function openEmbeddingCache(directory, { space, dimensions }) {
  fs.mkdirSync(directory, { recursive: true })
  const db = new DatabaseSync(path.join(directory, 'embedding-cache.sqlite'))
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS embeddings(key TEXT PRIMARY KEY,vector BLOB NOT NULL,sha256 TEXT NOT NULL); CREATE TABLE IF NOT EXISTS seen(document_id TEXT PRIMARY KEY,run_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS document_keys(document_id TEXT NOT NULL,key TEXT NOT NULL,PRIMARY KEY(document_id,key)); CREATE INDEX IF NOT EXISTS document_keys_key_idx ON document_keys(key);')
    const previous = db.prepare('SELECT value FROM meta WHERE key=?').get('space')?.value
    if (previous && previous !== space) fail()
    db.prepare('INSERT OR IGNORE INTO meta VALUES(?,?)').run('space', space)
  } catch (error) { db.close(); throw error }
  const transaction = action => { db.exec('BEGIN'); try { action(); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error } }
  const get = db.prepare('SELECT vector,sha256 FROM embeddings WHERE key=?')
  const put = db.prepare('INSERT OR REPLACE INTO embeddings VALUES(?,?,?)')
  const forget = db.prepare('DELETE FROM document_keys WHERE document_id=?')
  return {
    key: text => hash(`${space}\n${text}`),
    read(keys) {
      if (keys.length > 100000) fail()
      const output = new Map()
      for (const key of keys) {
        const row = get.get(key); if (!row) continue
        if (row.vector.byteLength !== dimensions * 4 || hash(row.vector) !== row.sha256) fail()
        const vector = new Float32Array(Uint8Array.from(row.vector).buffer)
        if (!vector.every(Number.isFinite) || !vector.some(value => value !== 0)) fail()
        output.set(key, vector)
      }
      return output
    },
    write(entries) {
      if (entries.length > 10) fail()
      const verified = entries.map(([key, values]) => {
        if ((!Array.isArray(values) && !ArrayBuffer.isView(values)) || values.length !== dimensions || !Array.from(values).every(Number.isFinite) || !Array.from(values).some(value => value !== 0)) fail()
        const typed = Float32Array.from(values)
        if (!typed.every(Number.isFinite)) fail()
        const blob = Buffer.from(typed.buffer); return [key, blob, hash(blob)]
      })
      transaction(() => { for (const row of verified) put.run(...row) })
    },
    // Only documents that leave the index need to be named. Tracking every live
    // document per run wrote the whole corpus into this table on every pass, which
    // cost more than the scan it was meant to protect.
    forgetDocuments(ids) { if (ids.length) transaction(() => { for (const id of ids) forget.run(id) }) },
    recordDocuments(documents, chunks) {
      const remove = db.prepare('DELETE FROM document_keys WHERE document_id=?')
      const insert = db.prepare('INSERT OR IGNORE INTO document_keys VALUES(?,?)')
      transaction(() => { for (const document of documents) remove.run(document.document_id); for (const item of chunks) insert.run(item.chunk.document_id, item.key) })
    },
    finish() {
      transaction(() => {
        db.exec('DELETE FROM seen; DELETE FROM embeddings WHERE key NOT IN (SELECT key FROM document_keys)')
      })
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    },
    close() { db.close() }
  }
}
