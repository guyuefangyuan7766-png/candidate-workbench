import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Index } from 'usearch';
import { spawnSync } from 'node:child_process';
import { materialSourceHash } from './search-vector-source.js';
export { readSearchDocuments, materialSourceHash } from './search-vector-source.js';

const MAX_K = 400;
const MAX_SOURCE_ROWS = 400;
export const VECTOR_CHUNK_VERSION = 'self-v3-600-80-redacted';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const unique = values => [...new Set(values.map(String))];
const placeholders = values => values.map(() => '?').join(',');

export function chunkResumeDocument(document, { size = 600, overlap = 80 } = {}) {
  if (!Number.isInteger(size) || size < 1 || size > 10000 || !Number.isInteger(overlap) || overlap < 0 || overlap >= size) fail('search_vector_chunk_invalid', 'Invalid chunk size or overlap');
  const content = String(document.content ?? '');
  if (!content.trim()) return [];
  const chunks = [];
  for (let start = 0, n = 0; start < content.length; n += 1) {
    let end = Math.min(content.length, start + size);
    if (end < content.length && /[\uD800-\uDBFF]/u.test(content[end - 1])) end -= 1;
    const text = content.slice(start, end);
    chunks.push({ id: `${document.document_id}:${n}`, candidate_id: String(document.candidate_id), document_id: String(document.document_id), source_type: String(document.source_type), source_id: String(document.source_id ?? document.document_id), title: String(document.title ?? ''), field: document.field ?? 'content', content: text, start, end, content_hash: digest(text), source_hash: document.source_hash ?? materialSourceHash(document) });
    if (end === content.length) break;
    start = end - overlap;
    if (/[\uDC00-\uDFFF]/u.test(content[start])) start += 1;
  }
  return chunks;
}

function normalizedVector(value, dimensions) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== dimensions) fail('search_vector_dimension', `Vector dimension must be ${dimensions}`);
  let sum = 0;
  for (const number of value) { if (typeof number !== 'number' || !Number.isFinite(number)) fail('search_vector_invalid', 'Vector values must be finite'); sum += number * number; }
  if (!Number.isFinite(sum) || sum === 0) fail('search_vector_invalid', 'Vector norm cannot be zero or nonfinite');
  return Float32Array.from(value, number => number / Math.sqrt(sum));
}
const toBlob = value => Buffer.from(value.buffer, value.byteOffset, value.byteLength);
const fromBlob = value => { const copy = Uint8Array.from(value); return new Float32Array(copy.buffer); };
// 量化用 f16 而非 f32：Windows 上 usearch 2.26.2 的只读 mmap 走 `GetFileSize()`
// （32 位 API），文件 ≥4 GiB 会取到错误长度并报 "vectors matrix exceeds file size"。
// 本项目 1,454,325×1024 维在 f32 下约 6.2 GB（已实测两次发布失败），f16 下约 3.2 GB，
// 既绕过该缺陷，也把读取端内存减半；单位向量半精度误差 ~1e-3，对召回可忽略。
// 修改此处必须同步改动下面的发布校验子进程。
const makeIndex = dimensions => new Index({ metric: 'cos', quantization: 'f16', dimensions, connectivity: 16, expansion_add: 128, expansion_search: 128 });
function safeFile(directory, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) fail('search_vector_corrupt', 'Invalid index manifest');
  const file = path.resolve(directory, relative); const root = path.resolve(directory) + path.sep;
  if (!file.startsWith(root)) fail('search_vector_corrupt', 'Invalid index manifest');
  return file;
}
function readManifest(directory) {
  const file = path.join(directory, 'manifest.json');
  if (!fs.existsSync(file)) return null;
  try { const manifest = JSON.parse(fs.readFileSync(file, 'utf8')); if (manifest.version !== 2 || !manifest.generation) throw new Error(); return manifest; }
  catch { fail('search_vector_corrupt', 'Invalid index manifest'); }
}
function fileHash(file) {
  const hash = crypto.createHash('sha256'); const buffer = Buffer.allocUnsafe(1024 * 1024); const fd = fs.openSync(file, 'r');
  try { let bytes; while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes)); return hash.digest('hex'); }
  finally { fs.closeSync(fd); }
}
// Hashing a published generation reads the whole index and vector database, which
// costs several gigabytes per open and therefore tens of seconds once the corpus
// is large. Record the verified identity instead so only the first open after a
// publication pays for it; the cheap file stamps still catch any later change.
const VERIFICATION_FILE = '.verified.json';
function readVerification(directory) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, VERIFICATION_FILE), 'utf8')); }
  catch { return null; }
}
function writeVerification(directory, value) {
  const target = path.join(directory, VERIFICATION_FILE);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value)); fs.renameSync(temporary, target); return true; }
  catch { try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ } return false; }
}
function writerLock(directory) {
  const lockPath = path.join(directory, '.build.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { const fd = fs.openSync(lockPath, 'wx'); fs.writeFileSync(fd, String(process.pid)); return fd; }
    catch (error) {
      if (error.code !== 'EEXIST') fail('search_vector_build_busy', 'Vector writer is unavailable');
      let pid; try { pid = Number(fs.readFileSync(lockPath, 'utf8')); } catch { continue; }
      if (!Number.isInteger(pid) || pid <= 0) fail('search_vector_build_busy', 'Vector writer lock requires recovery');
      try { process.kill(pid, 0); fail('search_vector_build_busy', 'Vector index already has a writer'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      fs.unlinkSync(lockPath);
    }
  }
  fail('search_vector_build_busy', 'Vector index already has a writer');
}

export function createVectorStore({ directory, dimensions = 1024, model = 'text-embedding-v4', chunkVersion = VECTOR_CHUNK_VERSION, readOnly = false, memoryMap = false, autoCommit = true, maxExactVectors = 10000, maxAnnVectors = 6400 } = {}) {
  if (!directory || !Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096) fail('search_vector_config_invalid', 'Directory and valid dimensions are required');
  if (![maxExactVectors, maxAnnVectors].every(n => Number.isInteger(n) && n > 0 && n <= 10000)) fail('search_vector_config_invalid', 'Invalid vector budget');
  const space = `${model}:${dimensions}:${chunkVersion}`;
  let manifest = readManifest(directory);
  if (manifest && manifest.embedding_space_id !== space) fail('search_vector_space_mismatch', 'Embedding space mismatch; use a separate index directory');
  if (readOnly && !manifest) fail('search_vector_not_ready', 'Vector index missing or not ready');
  let db; let index; let workingDirectory = null; let dirty = false; let closed = false; let key = 1; let stamps;
  let generation = manifest?.generation ?? null;
  let lock;
  const nativeAliases = new Map();
  function nativeIndexPath(file) {
    if (process.platform !== 'win32' || /^[\x00-\x7F]*$/u.test(file)) return file;
    const parent = path.dirname(file);
    let alias = nativeAliases.get(parent);
    if (!alias) {
      alias = path.join(os.tmpdir(), `beisen-usearch-${process.pid}-${crypto.randomUUID()}`);
      fs.symlinkSync(parent, alias, 'junction');
      nativeAliases.set(parent, alias);
    }
    return path.join(alias, path.basename(file));
  }
  function cleanupNativeAliases() {
    for (const alias of nativeAliases.values()) {
      try { fs.rmSync(alias, { recursive: true, force: true }); } catch { /* usearch may still hold a mapping */ }
    }
    nativeAliases.clear();
  }
  const stamp = file => { const s = fs.statSync(file, { bigint: true }); return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':'); };
  function assertCurrent() {
    if (closed) fail('search_vector_closed', 'Vector store is closed');
    if (workingDirectory || !manifest) return { generation, changed: false };
    try {
      if (stamp(safeFile(directory, manifest.database_file)) !== stamps.database || stamp(safeFile(directory, manifest.index_file)) !== stamps.index) throw new Error();
    } catch { fail('search_vector_corrupt', 'Vector generation changed outside publication'); }
    return { generation, changed: false };
  }
  function loadActive() {
    if (!manifest) return;
    const dbFile = safeFile(directory, manifest.database_file); const indexFile = safeFile(directory, manifest.index_file);
    if (!fs.existsSync(dbFile) || !fs.existsSync(indexFile) || fs.statSync(indexFile).size !== manifest.index_bytes) fail('search_vector_corrupt', 'Invalid or corrupt vector generation');
    const identity = { generation: manifest.generation, index: stamp(indexFile), database: stamp(dbFile) };
    const marker = readVerification(directory);
    const verified = Boolean(marker) && marker.generation === identity.generation && marker.index === identity.index && marker.database === identity.database;
    if (!verified) {
      if (fileHash(indexFile) !== manifest.index_sha256 || fileHash(dbFile) !== manifest.database_sha256) fail('search_vector_corrupt', 'Invalid or corrupt vector generation');
      writeVerification(directory, identity);
    }
    db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const meta = db.prepare('SELECT value FROM meta WHERE key=?').get('embedding_space_id')?.value;
      if (meta !== space) fail('search_vector_corrupt', 'Invalid vector space metadata');
      const facts = Number(db.prepare('SELECT count(*) AS n FROM facts').get().n);
      if (facts !== Number(manifest.vectors)) fail('search_vector_corrupt', 'Invalid vector generation count');
      if (readOnly) { index = makeIndex(dimensions); const nativeFile = nativeIndexPath(indexFile); if (memoryMap) index.view(nativeFile); else index.load(nativeFile); if (Number(index.size()) !== facts) fail('search_vector_corrupt', 'Invalid vector generation count'); }
      stamps = { database: stamp(dbFile), index: stamp(indexFile) };
    } catch { db.close(); db = null; index = null; fail('search_vector_corrupt', 'Invalid or corrupt vector index'); }
  }
  function ensureIndex() {
    assertCurrent();
    if (!index) {
      index = makeIndex(dimensions);
      if (manifest) index.load(nativeIndexPath(safeFile(directory, manifest.index_file)));
    }
    return index;
  }
  function refresh() {
    if (!readOnly) return assertCurrent();
    if (closed) fail('search_vector_closed', 'Vector store is closed');
    const next = readManifest(directory);
    if (!next) fail('search_vector_not_ready', 'Vector index missing or not ready');
    if (next.embedding_space_id !== space) fail('search_vector_space_mismatch', 'Embedding space mismatch');
    if (next.generation === generation) {
      assertCurrent();
      if (JSON.stringify(next) !== JSON.stringify(manifest)) fail('search_vector_corrupt', 'Active manifest changed without a generation');
      return { generation, changed: false };
    }
    const previous = { manifest, generation, db, index, stamps };
    manifest = next; generation = next.generation; db = null; index = null;
    try { loadActive(); }
    catch (error) { ({ manifest, generation, db, index, stamps } = previous); throw error; }
    previous.db?.close(); previous.index = null;
    return { generation, changed: true };
  }
  if (!readOnly) {
    fs.mkdirSync(directory, { recursive: true });
    try { lock = writerLock(directory); }
    catch (error) { throw error; }
    manifest = readManifest(directory);
    generation = manifest?.generation ?? null;
  }
  try {
    if (manifest && manifest.embedding_space_id !== space) fail('search_vector_space_mismatch', 'Embedding space mismatch; use a separate index directory');
    loadActive();
  } catch (error) { if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(path.join(directory, '.build.lock')); } throw error; }
  function ensureWorking() {
    if (closed) fail('search_vector_closed', 'Vector store is closed');
    if (readOnly) fail('search_vector_read_only', 'Vector store is read-only');
    if (workingDirectory) return;
    workingDirectory = path.join(directory, `generation-${crypto.randomUUID()}`); fs.mkdirSync(workingDirectory);
    const file = path.join(workingDirectory, 'vectors.sqlite');
    if (manifest) { db.close(); fs.copyFileSync(safeFile(directory, manifest.database_file), file); }
    db = new DatabaseSync(file);
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS embeddings(content_hash TEXT PRIMARY KEY,vector BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS facts(key INTEGER PRIMARY KEY,candidate_id TEXT NOT NULL,content_hash TEXT NOT NULL,UNIQUE(candidate_id,content_hash));
      CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,fact_key INTEGER NOT NULL,candidate_id TEXT NOT NULL,document_id TEXT NOT NULL,source_type TEXT NOT NULL,source_id TEXT NOT NULL,title TEXT NOT NULL,field TEXT NOT NULL,content TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,content_hash TEXT NOT NULL,source_hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks(document_id);
      CREATE INDEX IF NOT EXISTS chunks_fact_idx ON chunks(fact_key);
      CREATE INDEX IF NOT EXISTS chunks_candidate_idx ON chunks(candidate_id);
      CREATE TABLE IF NOT EXISTS documents(document_id TEXT PRIMARY KEY,source_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS build_seen(document_id TEXT PRIMARY KEY); DELETE FROM build_seen;`);
    // Generations published before revisions existed carry only the material hash.
    // A null revision simply means "read the body once more", never "unchanged".
    if (!db.prepare(`SELECT 1 FROM pragma_table_info('documents') WHERE name='revision'`).get())
      db.exec('ALTER TABLE documents ADD COLUMN revision TEXT');
    db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('embedding_space_id', space);
    key = Number(db.prepare('SELECT coalesce(max(key),0)+1 AS n FROM facts').get().n);
  }
  const count = table => db ? Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n) : 0;
  function commit() {
    if (readOnly) fail('search_vector_read_only', 'Vector store is read-only');
    if (!dirty && manifest) return status();
    ensureWorking();
    const indexFile = path.join(workingDirectory, 'vectors.usearch');
    const nativeFile = nativeIndexPath(indexFile);
    if (index) index.save(nativeFile);
    else if (manifest) fs.copyFileSync(safeFile(directory, manifest.index_file), indexFile);
    else ensureIndex().save(nativeFile);
    // 发布前自愈：清理没有任何 chunk 引用的孤儿 fact（它们同时存在于 facts 与索引，
    // 属于历史遗留的死重），并同步从索引里移除，保证 size()==facts。
    try {
      const orphanKeys = db.prepare('SELECT key FROM facts WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.fact_key = facts.key)').all().map((row) => Number(row.key));
      if (orphanKeys.length) {
        for (const orphanKey of orphanKeys) { try { index?.remove(BigInt(orphanKey)); } catch { /* 索引里可能本就没有该键 */ } }
        db.prepare(`DELETE FROM facts WHERE key IN (${orphanKeys.map(() => '?').join(',')})`).run(...orphanKeys);
      }
    } catch { /* 自愈失败不影响后续校验：校验会如实报错 */ }
    // 保存后释放内存里的 HNSW 图（150 万向量 ≈ 6.5 GB），减少发布阶段的内存压力；
    // 后续若还需写入，ensureIndex() 会从已发布的 manifest 重新加载。
    index = null;
    db.exec('DELETE FROM embeddings WHERE content_hash NOT IN (SELECT content_hash FROM facts); PRAGMA optimize;');
    const chunkCount = count('chunks'); const factCount = count('facts'); const documentCount = count('documents');
    db.close(); db = null;
    // 校验已落盘的索引文件：必须用一次性子进程（绑定没有 unmap/close，同进程 mmap
    // 会让测试和运维无法删除该目录）。失败时把 expected/actual 落盘到
    // publication-check.json，避免再出现「只知失败、不知差多少」。
    const writePublicationCheck = (value) => {
      try { fs.writeFileSync(path.join(directory, 'publication-check.json'), `${JSON.stringify({ at: new Date().toISOString(), ...value }, null, 2)}\n`); } catch { /* 诊断写入失败不影响发布判定 */ }
    };
    const verification = spawnSync(process.execPath, ['--input-type=module', '-e', `import { Index } from ${JSON.stringify(import.meta.resolve('usearch'))}; const index = new Index({dimensions:Number(process.argv[2]),metric:'cos',quantization:'f16'}); index.view(process.argv[1]); console.log(JSON.stringify({ size: Number(index.size()) }));`, nativeFile, String(dimensions)], { windowsHide: true, timeout: 600000, encoding: 'utf8' });
    let verifiedVectors = null;
    try { verifiedVectors = Number(JSON.parse(String(verification.stdout ?? '').trim().split('\n').filter(Boolean).pop()).size); } catch { verifiedVectors = null; }
    if (verification.status !== 0 || verification.error || verifiedVectors !== factCount) {
      writePublicationCheck({
        result: verification.status === 0 ? 'count_mismatch' : 'verifier_failed',
        expected_facts: factCount, verified_vectors: verifiedVectors,
        exit_status: verification.status ?? null, signal: verification.signal ?? null, error: verification.error?.code ?? null,
        stderr: String(verification.stderr ?? '').slice(0, 300),
        chunks: chunkCount, documents: documentCount
      });
      fail('search_vector_corrupt', `Invalid staged index count: saved ${verifiedVectors} vs facts ${factCount}`);
    }
    writePublicationCheck({ result: 'ok', expected_facts: factCount, verified_vectors: verifiedVectors, chunks: chunkCount, documents: documentCount });
    const next = { version: 2, generation: path.basename(workingDirectory), previous_generation: manifest?.generation ?? null, embedding_space_id: space, model, dimensions, chunk_version: chunkVersion, chunks: chunkCount, vectors: factCount, documents: documentCount, database_file: `${path.basename(workingDirectory)}/vectors.sqlite`, index_file: `${path.basename(workingDirectory)}/vectors.usearch`, index_bytes: fs.statSync(indexFile).size, index_sha256: fileHash(indexFile), database_sha256: fileHash(path.join(workingDirectory, 'vectors.sqlite')), created_at: new Date().toISOString() };
    const temporary = path.join(directory, `manifest-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(next));
    const fd = fs.openSync(temporary, 'r+'); fs.fsyncSync(fd); fs.closeSync(fd);
    fs.renameSync(temporary, path.join(directory, 'manifest.json'));
    manifest = next; generation = next.generation; workingDirectory = null; dirty = false;
    db = new DatabaseSync(safeFile(directory, manifest.database_file), { readOnly: true });
    stamps = { database: stamp(safeFile(directory, manifest.database_file)), index: stamp(indexFile) };
    writeVerification(directory, { generation: next.generation, index: stamps.index, database: stamps.database });
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^generation-[a-f0-9-]{36}$/u.test(entry.name) || [next.generation, next.previous_generation].includes(entry.name)) continue;
      const retired = path.resolve(directory, entry.name);
      if (path.dirname(retired) === path.resolve(directory)) { try { fs.rmSync(retired, { recursive: true, force: true }); } catch { /* A reader can still own the retired generation on Windows. */ } }
    }
    return status();
  }
  const changed = () => { dirty = true; if (autoCommit) commit(); };
  function cleanupFacts(keys) {
    const exists = db.prepare('SELECT 1 FROM chunks WHERE fact_key=? LIMIT 1');
    const remove = db.prepare('DELETE FROM facts WHERE key=?');
    for (const factKey of keys) if (!exists.get(factKey)) { ensureIndex().remove(BigInt(factKey)); remove.run(factKey); }
  }
  function upsertChunks(chunks, vectors) {
    if (readOnly) fail('search_vector_read_only', 'Vector store is read-only');
    if (!Array.isArray(chunks) || !Array.isArray(vectors) || chunks.length !== vectors.length || chunks.length > 10000) fail('search_vector_invalid', 'Invalid bounded chunk batch');
    const verified = chunks.map((item, n) => {
      if (!item?.id || !item.candidate_id || !item.document_id || !['candidate', 'profile_section', 'attachment'].includes(item.source_type) || typeof item.content !== 'string') fail('search_vector_invalid', 'Invalid chunk provenance');
      return { chunk: { ...item, content_hash: digest(item.content) }, vector: normalizedVector(vectors[n], dimensions) };
    });
    if (!chunks.length) return;
    ensureWorking();
    ensureIndex();
    db.exec('BEGIN');
    try {
      const affected = new Set();
      for (const { chunk: item, vector: values } of verified) {
        const previous = db.prepare('SELECT fact_key FROM chunks WHERE id=?').get(item.id); if (previous) affected.add(previous.fact_key);
        db.prepare('INSERT OR IGNORE INTO embeddings VALUES(?,?)').run(item.content_hash, toBlob(values));
        let fact = db.prepare('SELECT key FROM facts WHERE candidate_id=? AND content_hash=?').get(item.candidate_id, item.content_hash);
        if (!fact) { fact = { key: key++ }; db.prepare('INSERT INTO facts VALUES(?,?,?)').run(fact.key, item.candidate_id, item.content_hash); index.add(BigInt(fact.key), values); }
        db.prepare('INSERT OR REPLACE INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(item.id, fact.key, item.candidate_id, item.document_id, item.source_type, item.source_id ?? item.document_id, item.title ?? '', item.field ?? 'content', item.content, item.start ?? 0, item.end ?? item.content.length, item.content_hash, item.source_hash ?? materialSourceHash(item));
        // Chunk writes refresh the material hash only; the revision that drives
        // incremental maintenance is owned by recordDocuments.
        db.prepare('INSERT INTO documents(document_id,source_hash,revision) VALUES(?,?,NULL) ON CONFLICT(document_id) DO UPDATE SET source_hash=excluded.source_hash').run(item.document_id, item.source_hash ?? materialSourceHash(item));
      }
      cleanupFacts(affected); db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    changed();
  }
  function removeDocuments(documentIds) {
    if (readOnly) fail('search_vector_read_only', 'Vector store is read-only');
    if (!documentIds?.length) return;
    if (documentIds.length > 10000) fail('search_vector_source_budget', 'Document removal exceeds bounded limit');
    assertCurrent(); const ids = unique(documentIds);
    if (!db || (!db.prepare(`SELECT 1 FROM documents WHERE document_id IN (${placeholders(ids)}) LIMIT 1`).get(...ids) && !db.prepare(`SELECT 1 FROM chunks WHERE document_id IN (${placeholders(ids)}) LIMIT 1`).get(...ids))) return;
    ensureWorking();
    const affected = db.prepare(`SELECT DISTINCT fact_key FROM chunks WHERE document_id IN (${placeholders(ids)})`).all(...ids).map(row => row.fact_key);
    let removed = 0; let documentsRemoved = 0;
    db.exec('BEGIN');
    try {
      removed = db.prepare(`DELETE FROM chunks WHERE document_id IN (${placeholders(ids)})`).run(...ids).changes;
      documentsRemoved = db.prepare(`DELETE FROM documents WHERE document_id IN (${placeholders(ids)})`).run(...ids).changes;
      if (removed) cleanupFacts(affected);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (removed || documentsRemoved) changed();
  }
  function checkSearch(signal) {
    assertCurrent();
    if (signal?.aborted) fail('search_cancelled', 'Vector search cancelled');
  }
  function filtersFor({ candidateIds, sourceTypes, fields } = {}) {
    const clauses = []; const parameters = [];
    for (const [column, values] of [['candidate_id', candidateIds], ['source_type', sourceTypes], ['field', fields]]) {
      if (values?.length === 0) clauses.push('0');
      else if (values) { const list = unique(values); clauses.push(`c.${column} IN (${placeholders(list)})`); parameters.push(...list); }
    }
    return { predicate: clauses.length ? clauses.join(' AND ') : '1', parameters };
  }
  function searchQualifiedFacts(queryVector, options = {}) {
    checkSearch(options.signal);
    const query = normalizedVector(queryVector, dimensions);
    if ((options.candidateIds?.length ?? 0) > 10000) fail('search_vector_filter_budget', 'Candidate filter exceeds vector budget');
    const { predicate, parameters } = filtersFor(options);
    if (!db) return { facts: [], approximate: false, bounded: false, generation, inspected_facts: 0 };
    const size = db.prepare(`SELECT DISTINCT c.fact_key FROM chunks c WHERE ${predicate} LIMIT ?`).all(...parameters, maxExactVectors + 1).length;
    if (size > maxExactVectors) fail('search_vector_filter_budget', 'Qualified vector set exceeds exact scoring budget');
    const facts = [];
    const rows = db.prepare(`SELECT DISTINCT c.fact_key,f.candidate_id,e.vector FROM chunks c JOIN facts f ON f.key=c.fact_key JOIN embeddings e ON e.content_hash=f.content_hash WHERE ${predicate}`).iterate(...parameters);
    for (const row of rows) {
      if (options.signal?.aborted) fail('search_cancelled', 'Vector search cancelled');
      const values = fromBlob(row.vector); let score = 0;
      for (let n = 0; n < dimensions; n++) score += values[n] * query[n];
      facts.push({ key: row.fact_key, candidate_id: row.candidate_id, score });
    }
    facts.sort((a, b) => b.score - a.score || a.key - b.key);
    return { facts, approximate: false, bounded: false, generation, inspected_facts: facts.length };
  }
  function searchAnn(queryVector, { limit = 400, sourceTypes, signal } = {}) {
    checkSearch(signal);
    const query = normalizedVector(queryVector, dimensions);
    if (!Number.isInteger(limit) || limit < 1 || limit > maxAnnVectors) fail('search_vector_filter_budget', 'ANN window exceeds bounded limit');
    const active = ensureIndex(); const size = Number(active.size());
    if (!size || sourceTypes?.length === 0) return { facts: [], approximate: true, bounded: false, generation, inspected_facts: 0, index_vectors: size };
    const matches = active.search(query, Math.min(size, limit), 1);
    checkSearch(signal);
    const { predicate, parameters } = filtersFor({ sourceTypes });
    const get = db.prepare(`SELECT f.key,f.candidate_id FROM facts f WHERE f.key=? AND EXISTS(SELECT 1 FROM chunks c WHERE c.fact_key=f.key AND ${predicate})`);
    const facts = [];
    for (let n = 0; n < matches.keys.length; n++) { const row = get.get(Number(matches.keys[n]), ...parameters); if (row) facts.push({ ...row, score: 1 - Number(matches.distances[n]) }); }
    facts.sort((a, b) => b.score - a.score || a.key - b.key);
    return { facts, approximate: true, bounded: size > matches.keys.length, generation, inspected_facts: matches.keys.length, index_vectors: size };
  }
  function readFactChunks(factKeys, { sourceTypes, fields, after = '', limit = 400 } = {}) {
    assertCurrent();
    if (!Array.isArray(factKeys) || factKeys.length > 400 || !Number.isInteger(limit) || limit < 1 || limit > 400 || typeof after !== 'string') fail('search_vector_source_budget', 'Fact provenance page exceeds bounded limit');
    if (!factKeys.length || !db) return { rows: [], next: null };
    const { predicate, parameters } = filtersFor({ sourceTypes, fields });
    const rows = db.prepare(`SELECT c.id,c.fact_key,c.candidate_id,c.document_id,c.source_type,c.source_id,c.field,c.start,c.end,c.source_hash FROM chunks c WHERE c.fact_key IN (${placeholders(factKeys)}) AND c.id>? AND ${predicate} ORDER BY c.id LIMIT ?`).all(...factKeys, after, ...parameters, limit);
    return { rows, next: rows.length === limit ? rows.at(-1).id : null };
  }
  function search(queryVector, { candidateIds, sourceTypes, fields, k = 20, signal } = {}) {
    if (!Number.isInteger(k) || k < 1 || k > MAX_K) fail('search_vector_invalid', `k must be between 1 and ${MAX_K}`);
    const options = { candidateIds, sourceTypes, fields, signal };
    const found = candidateIds || sourceTypes || fields
      ? searchQualifiedFacts(queryVector, options)
      : searchAnn(queryVector, { signal, limit: Math.min(maxAnnVectors, Math.max(k * 8, 400)) });
    const { predicate, parameters } = filtersFor(options);
    const results = []; const candidates = new Set();
    const get = db?.prepare(`SELECT c.* FROM chunks c WHERE c.fact_key=? AND ${predicate} ORDER BY c.document_id,c.start LIMIT 1`);
    for (const hit of found.facts) {
      if (candidates.has(hit.candidate_id)) continue;
      const row = get.get(hit.key, ...parameters); if (!row) continue;
      candidates.add(hit.candidate_id); results.push({ ...row, score: hit.score, embedding_space_id: space, generation });
      if (results.length === k) break;
    }
    Object.defineProperty(results, 'completeness', { value: { approximate: found.approximate, bounded: found.bounded, scored_vectors: found.inspected_facts }, enumerable: false });
    return results;
  }
  function listDocuments({ after = '', limit = 400 } = {}) {
    assertCurrent();
    if (typeof after !== 'string' || !Number.isInteger(limit) || limit < 1 || limit > 400) fail('search_vector_source_budget', 'Document page exceeds bounded limit');
    return db ? db.prepare('SELECT document_id,source_hash FROM documents WHERE document_id>? ORDER BY document_id LIMIT ?').all(after, limit).map(row => ({ ...row })) : [];
  }
  function recordDocuments(documents) {
    if (readOnly) fail('search_vector_read_only', 'Vector store is read-only');
    if (!Array.isArray(documents) || documents.length > 400 || documents.some(row => typeof row.document_id !== 'string' || !row.document_id || typeof row.source_hash !== 'string' || !row.source_hash)) fail('search_vector_source_budget', 'Invalid document record batch');
    if (!documents.length) return;
    const existing = listDocumentsForIds(documents.map(row => row.document_id));
    const changedRows = documents.filter(row => {
      const current = existing.get(row.document_id);
      return !current || current.source_hash !== row.source_hash || (row.revision ?? null) !== (current.revision ?? null);
    });
    if (!changedRows.length) return;
    ensureWorking(); const insert = db.prepare('INSERT OR REPLACE INTO documents VALUES(?,?,?)');
    db.exec('BEGIN'); try { for (const row of changedRows) insert.run(row.document_id, row.source_hash, row.revision ?? null); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    changed();
  }
  // Generations published before revisions existed are read as "revision unknown",
  // which makes their documents look stale once and then carry a revision again.
  const revisionSelect = () => db?.prepare(`SELECT 1 FROM pragma_table_info('documents') WHERE name='revision'`).get() ? 'revision' : 'NULL AS revision';
  function listDocumentsForIds(ids) { return db && ids.length ? new Map(db.prepare(`SELECT document_id,source_hash,${revisionSelect()} FROM documents WHERE document_id IN (${placeholders(ids)})`).all(...ids).map(row => [row.document_id, row])) : new Map(); }
  function status() {
    assertCurrent();
    return { chunks: !workingDirectory && manifest ? manifest.chunks : count('chunks'), vectors: !workingDirectory && manifest ? manifest.vectors : count('facts'), documents: !workingDirectory && manifest?.documents !== undefined ? manifest.documents : count('documents'), dimensions, model, embedding_space_id: space, generation, index_ready: Boolean(manifest), read_only: readOnly, memory_mapped: readOnly && memoryMap, algorithm: 'usearch-hnsw-cos-f16', max_ann_vectors: maxAnnVectors };
  }
  return {
    upsertChunks, removeDocuments, search, searchQualifiedFacts, searchAnn, readFactChunks, status, commit, refresh, assertCurrent, listDocuments, recordDocuments,
    getDocumentHashes: ids => { if (!db || !ids.length) return new Map(); if (ids.length > MAX_SOURCE_ROWS) fail('search_vector_source_budget', 'Hash page exceeds bounded limit'); return new Map(db.prepare(`SELECT document_id,source_hash FROM documents WHERE document_id IN (${placeholders(ids)})`).all(...ids).map(x => [x.document_id, x.source_hash])); },
    getDocumentMeta: ids => { if (!db || !ids.length) return new Map(); if (ids.length > MAX_SOURCE_ROWS) fail('search_vector_source_budget', 'Revision page exceeds bounded limit'); return new Map(db.prepare(`SELECT document_id,source_hash,${revisionSelect()} FROM documents WHERE document_id IN (${placeholders(ids)})`).all(...ids).map(x => [x.document_id, x])); },
    getCachedVectors: hashes => { if (!db || !hashes.length) return new Map(); if (hashes.length > 10000) fail('search_vector_source_budget', 'Cache batch exceeds bounded limit'); return new Map(db.prepare(`SELECT content_hash,vector FROM embeddings WHERE content_hash IN (${placeholders(hashes)})`).all(...hashes).map(x => [x.content_hash, fromBlob(x.vector)])); },
    markSeen: ids => { ensureWorking(); const insert = db.prepare('INSERT OR IGNORE INTO build_seen VALUES(?)'); db.exec('BEGIN'); try { for (const id of ids) insert.run(id); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } },
    pruneUnseen: () => { ensureWorking(); let removed = 0; while (true) { const ids = db.prepare('SELECT document_id FROM documents WHERE document_id NOT IN (SELECT document_id FROM build_seen) LIMIT 400').all().map(x => x.document_id); if (!ids.length) break; removed += ids.length; removeDocuments(ids); } return removed; },
  close: () => { if (closed) return; db?.close(); db = null; index = null; closed = true; cleanupNativeAliases(); if (workingDirectory && path.dirname(path.resolve(workingDirectory)) === path.resolve(directory)) fs.rmSync(workingDirectory, { recursive: true, force: true }); if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(path.join(directory, '.build.lock')); } },
  };
}
