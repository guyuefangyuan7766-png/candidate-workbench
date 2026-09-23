import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Index } from 'usearch';
import { createVectorStore, chunkResumeDocument, readSearchDocuments } from '../../server/search-vector-store.js';
import { buildVectorIndex } from '../../server/search-vector-maintenance.js';
import { openDatabase } from '../../server/database.js';

async function fixture(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'beisen-anonymous-vector-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}
const vector = (n, index = 0) => Array.from({ length: n }, (_, i) => Number(i === index));
const chunk = (id, candidate = 'c1', text = 'Unity', extra = {}) => ({ id, candidate_id: candidate, document_id: `section:${id}`, source_type: 'profile_section', source_id: id, title: 'Skills', content: text, start: 0, end: text.length, source_hash: `source-${id}`, ...extra });
function createSource(directory) {
  const databasePath = path.join(directory, 'anonymous.sqlite');
  const db = openDatabase(databasePath, { synchronizeSearch: false });
  db.prepare('INSERT INTO candidates(id,name,current_title,self_summary,tags,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('c1', 'Anonymous One', 'Developer', 'Builds software', '["Unity"]', 'v1', 'v1');
  db.prepare('INSERT INTO candidate_profile_sections(id,candidate_id,section_type,title,content,structured_data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('s1', 'c1', 'project', 'Project', '  Unity battle systems\n', '{"linked_position":{"description":"SECRET_LINKED_JD"}}', 'v1', 'v1');
  return { db, databasePath };
}

test('chunk offsets point into unchanged source including leading spaces and overlap', () => {
  const document = { candidate_id: 'c1', document_id: 'd1', source_type: 'profile_section', source_id: 's1', title: 'Skills', content: `  ${'Unity '.repeat(200)}\n` };
  const chunks = chunkResumeDocument(document, { size: 600, overlap: 80 });
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].content.startsWith('  '), true);
  for (const item of chunks) assert.equal(item.content, document.content.slice(item.start, item.end));
  assert.equal(chunks[1].start, 520);
  assert.equal(chunks.at(-1).end, document.content.length);
});

test('source material uses real schema, whitelists fields and excludes archived and linked sources', async t => {
  const directory = await fixture(t); const { db, databasePath } = createSource(directory);
  db.prepare('UPDATE candidates SET phone=?,email=? WHERE id=?').run('SECRET_PHONE', 'SECRET_EMAIL', 'c1');
  db.prepare('INSERT INTO candidate_profile_sections(id,candidate_id,section_type,title,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('s2', 'c1', 'other', 'Other', 'SECRET_OTHER', 'v1', 'v1');
  const docs = readSearchDocuments(db, { candidateIds: ['c1'] });
  assert.ok(docs.length >= 2);
  assert.equal(JSON.stringify(docs).includes('SECRET_'), false);
  assert.equal(docs.find(x => x.source_id === 's1').content, '  Unity battle systems\n');
  db.prepare('UPDATE candidate_profile_sections SET archived_at=? WHERE id=?').run('v2', 's1');
  assert.equal(readSearchDocuments(db, { candidateIds: ['c1'] }).some(x => x.source_id === 's1'), false);
  db.prepare('UPDATE candidates SET archived_at=? WHERE id=?').run('v3', 'c1');
  assert.deepEqual(readSearchDocuments(db, { candidateIds: ['c1'] }), []);
  db.close();
  const before = fs.statSync(databasePath).size;
  assert.deepEqual(readSearchDocuments(databasePath), []);
  assert.equal(fs.statSync(databasePath).size, before);
});

test('HNSW persists updates, deduplicates candidates and filters before bounded exact scoring', async t => {
  const directory = await fixture(t);
  let store = createVectorStore({ directory, dimensions: 3, model: 'stub-v1' });
  store.upsertChunks([chunk('a'), chunk('b', 'c2', 'Unreal'), chunk('c')], [vector(3), vector(3, 1), vector(3)]);
  assert.equal(store.search(vector(3), { k: 5 })[0].candidate_id, 'c1');
  assert.equal(store.search(vector(3), { k: 5 }).length, 2);
  assert.deepEqual(store.search(vector(3), { k: 5, candidateIds: ['c2'] }).map(x => x.candidate_id), ['c2']);
  assert.deepEqual(store.search(vector(3), { k: 5, candidateIds: [] }), []);
  store.upsertChunks([chunk('b', 'c2', 'Updated')], [vector(3)]);
  store.removeDocuments(['section:a', 'section:c']);
  const generation = store.status().generation;
  store.close();
  store = createVectorStore({ directory, dimensions: 3, model: 'stub-v1', readOnly: true });
  assert.equal(store.status().chunks, 1);
  assert.equal(store.status().generation, generation);
  assert.equal(store.search(vector(3), { k: 5 })[0].content, 'Updated');
  assert.throws(() => store.upsertChunks([chunk('x')], [vector(3)]), /read.only/iu);
  store.close();
});

test('read only missing, incompatible or damaged indexes fail without creating files', async t => {
  const directory = await fixture(t); const missing = path.join(directory, 'missing');
  assert.throws(() => createVectorStore({ directory: missing, dimensions: 2, readOnly: true }), /not.ready|missing/iu);
  assert.equal(fs.existsSync(missing), false);
  const store = createVectorStore({ directory, dimensions: 2, model: 'stub-v1' });
  store.upsertChunks([chunk('a')], [[1, 0]]); store.close();
  assert.throws(() => createVectorStore({ directory, dimensions: 3, model: 'stub-v1', readOnly: true }), /space|dimension/iu);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(directory, manifest.index_file), 'corrupt');
  assert.throws(() => createVectorStore({ directory, dimensions: 2, model: 'stub-v1', readOnly: true }), /corrupt|invalid/iu);
});

test('invalid vectors are rejected before mutation and filter budget is explicit', async t => {
  const directory = await fixture(t); const store = createVectorStore({ directory, dimensions: 2, model: 'stub-v1', maxExactVectors: 1 });
  assert.throws(() => store.upsertChunks([chunk('a')], [[1, 2, 3]]), /dimension/iu);
  assert.throws(() => store.upsertChunks([chunk('a')], [[NaN, 0]]), /finite/iu);
  assert.throws(() => store.upsertChunks([chunk('a')], [[0, 0]]), /zero/iu);
  assert.equal(store.status().chunks, 0);
  store.upsertChunks([chunk('a'), chunk('b', 'c1', 'Unreal')], [[1, 0], [0, 1]]);
  assert.throws(() => store.search([1, 0], { candidateIds: ['c1'], k: 5 }), error => error.code === 'search_vector_filter_budget');
  assert.throws(() => store.search([1, 0], { k: 0 }), /k /iu);
  store.close();
});

test('incremental generation skips unchanged embeddings, updates source and prunes deleted or archived documents', async t => {
  const directory = await fixture(t); const { db, databasePath } = createSource(directory); const indexDir = path.join(directory, 'index');
  const counts = []; const embedTexts = async texts => { counts.push(texts.length); return texts.map(() => [1, 0]); };
  const args = { databasePath, directory: indexDir, dimensions: 2, model: 'stub-v1', embedTexts };
  const first = await buildVectorIndex(args); assert.ok(first.embedded_chunks > 0);
  const firstCalls = counts.length; const second = await buildVectorIndex(args);
  assert.equal(counts.length, firstCalls); assert.equal(second.embedded_chunks, 0);
  assert.equal(second.status.generation, first.status.generation);
  db.prepare('UPDATE candidate_profile_sections SET content=?,updated_at=? WHERE id=?').run('Unreal gameplay', 'v2', 's1');
  await buildVectorIndex(args); assert.equal(counts.length, firstCalls + 1);
  db.prepare('DELETE FROM candidate_profile_sections WHERE id=?').run('s1');
  await buildVectorIndex(args);
  let store = createVectorStore({ directory: indexDir, dimensions: 2, model: 'stub-v1', readOnly: true });
  assert.equal(store.search([1, 0], { k: 10 }).some(x => x.document_id === 'section:s1'), false); store.close();
  db.prepare('UPDATE candidates SET archived_at=? WHERE id=?').run('v3', 'c1');
  await buildVectorIndex(args); db.close();
  store = createVectorStore({ directory: indexDir, dimensions: 2, model: 'stub-v1', readOnly: true });
  assert.equal(store.status().chunks, 0); store.close();
});

test('failed or cancelled builds preserve the complete active generation', async t => {
  const directory = await fixture(t); const { db, databasePath } = createSource(directory); const indexDir = path.join(directory, 'index');
  const args = { databasePath, directory: indexDir, dimensions: 2, model: 'stub-v1', embedTexts: async texts => texts.map(() => [1, 0]) };
  await buildVectorIndex(args);
  const before = fs.readFileSync(path.join(indexDir, 'manifest.json'), 'utf8');
  db.prepare('UPDATE candidate_profile_sections SET content=?,updated_at=? WHERE id=?').run('Updated project', 'v2', 's1');
  await assert.rejects(() => buildVectorIndex({ ...args, embedTexts: async () => { throw new Error('offline'); } }), /offline/iu);
  assert.equal(fs.readFileSync(path.join(indexDir, 'manifest.json'), 'utf8'), before);
  const controller = new AbortController();
  await assert.rejects(() => buildVectorIndex({ ...args, signal: controller.signal, embedTexts: async texts => { controller.abort(); return texts.map(() => [1, 0]); } }), /cancel/iu);
  assert.equal(fs.readFileSync(path.join(indexDir, 'manifest.json'), 'utf8'), before);
  await buildVectorIndex(args); db.close();
  assert.notEqual(fs.readFileSync(path.join(indexDir, 'manifest.json'), 'utf8'), before);
});

test('identical material reuses embeddings across source records and batching never exceeds ten', async t => {
  const directory = await fixture(t); const { db, databasePath } = createSource(directory);
  for (let i = 0; i < 23; i++) db.prepare('INSERT INTO candidate_profile_sections(id,candidate_id,section_type,title,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(`extra${i}`, 'c1', 'skill', 'Skill', `Skill ${i % 12}`, 'v1', 'v1');
  db.close(); let inputCount = 0; const sizes = [];
  await buildVectorIndex({ databasePath, directory: path.join(directory, 'index'), dimensions: 2, model: 'stub-v1', embedTexts: async texts => { inputCount += texts.length; sizes.push(texts.length); return texts.map(() => [1, 0]); } });
  assert.equal(inputCount, 14); assert.equal(Math.max(...sizes), 10);
});

test('CLI rejects the default business database before opening or externalizing data', () => {
  const result = spawnSync(process.execPath, ['scripts/search-vector-maintenance.mjs', '--database', 'data/recruitment.db', '--directory', 'irrelevant', '--anonymous', 'true'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /anonymous|business|rejected/iu);
  assert.equal(result.stderr.includes(process.cwd()), false);
});

test('a crashed writer lock can be recovered and duplicate source removal keeps surviving evidence', async t => {
  const directory = await fixture(t);
  fs.writeFileSync(path.join(directory, '.build.lock'), '2147483647');
  const store = createVectorStore({ directory, dimensions: 2, model: 'stub-v1' });
  store.upsertChunks([chunk('a'), chunk('b')], [[1, 0], [1, 0]]);
  assert.equal(store.status().vectors, 1);
  store.removeDocuments(['section:a']);
  assert.equal(store.search([1, 0], { k: 5 })[0].document_id, 'section:b');
  store.close();
});

test('same-size index corruption is rejected before native loading', async t => {
  const directory = await fixture(t); const store = createVectorStore({ directory, dimensions: 2, model: 'stub-v1' });
  store.upsertChunks([chunk('a')], [[1, 0]]); store.close();
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const file = path.join(directory, manifest.index_file); const bytes = fs.readFileSync(file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
  assert.throws(() => createVectorStore({ directory, dimensions: 2, model: 'stub-v1', readOnly: true }), /corrupt|invalid/iu);
});

test('a late qualified candidate is retrieved even after over 1600 closer ineligible vectors', async t => {
  const directory = await fixture(t); const store = createVectorStore({ directory, dimensions: 2, model: 'stub-v1', autoCommit: false });
  const chunks = Array.from({ length: 1650 }, (_, n) => chunk(`a${n}`, `c${n}`, `Anonymous skill ${n}`));
  chunks.push(chunk('late', 'qualified', 'Unreal'));
  store.upsertChunks(chunks, [...chunks.slice(0, -1).map(() => [1, 0]), [0, 1]]); store.commit();
  assert.equal(store.search([1, 0], { candidateIds: ['qualified'], k: 5 })[0].candidate_id, 'qualified');
  store.close();
});

test('attachment sources require a parsed committed resume and expose no filename or storage path', async t => {
  const directory = await fixture(t); const { db } = createSource(directory);
  const insert = db.prepare('INSERT INTO candidate_attachments(id,candidate_id,original_filename,storage_path,mime_type,file_size,sha256,parse_status,parser_version,extracted_text,attachment_type,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  insert.run('a1','c1','SECRET_FILENAME','SECRET_STORAGE','text/plain',10,'a'.repeat(64),'parsed','v1','  Verified resume\n','resume','v1','v1');
  insert.run('a2','c1','PRIVATE','PRIVATE','text/plain',10,'b'.repeat(64),'pending','v1','PENDING_SECRET','resume','v1','v1');
  insert.run('a3','c1','PRIVATE','PRIVATE','text/plain',10,'c'.repeat(64),'parsed','v1','CONTRACT_SECRET','contract','v1','v1');
  const docs = readSearchDocuments(db, { candidateIds: ['c1'] });
  assert.deepEqual(docs.filter(x => x.source_type === 'attachment').map(x => x.source_id), ['a1']);
  assert.equal(docs.find(x => x.source_id === 'a1').content, '  Verified resume\n');
  assert.equal(JSON.stringify(docs).includes('SECRET'), false); db.close();
});

test('existing work section alias supplies the same owned material as experience', async t => {
  const directory = await fixture(t); const { db } = createSource(directory);
  db.prepare('INSERT INTO candidate_profile_sections(id,candidate_id,section_type,title,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('work-alias', 'c1', 'work', 'Work', 'Anonymous engine development', 'v1', 'v1');
  assert.equal(readSearchDocuments(db, { documentIds: ['section:work-alias'] })[0]?.content, 'Anonymous engine development');
  db.close();
});

test('bounded ANN facts coexist with sparse exact scoring and provenance paging', async t => {
  const directory = await fixture(t);
  const store = createVectorStore({ directory, dimensions: 2, model: 'stub-v1', autoCommit: false, maxExactVectors: 1, maxAnnVectors: 8 });
  t.after(() => store.close());
  store.upsertChunks([chunk('a'), chunk('b', 'c2', 'Unreal'), chunk('duplicate')], [[1, 0], [0, 1], [1, 0]]);
  const exact = store.searchQualifiedFacts([1, 0], { candidateIds: ['c2'] });
  assert.equal(exact.approximate, false);
  assert.equal(exact.facts[0].candidate_id, 'c2');
  assert.throws(() => store.searchQualifiedFacts([1, 0], { candidateIds: ['c1', 'c2'] }), { code: 'search_vector_filter_budget' });
  const ann = store.searchAnn([1, 0], { limit: 8 });
  assert.equal(ann.approximate, true);
  assert.equal(ann.facts.length, 2);
  assert.throws(() => store.searchAnn([1, 0], { limit: 9 }), { code: 'search_vector_filter_budget' });
  const first = store.readFactChunks([ann.facts[0].key], { limit: 1 });
  const second = store.readFactChunks([ann.facts[0].key], { limit: 1, after: first.next });
  assert.notEqual(first.rows[0].document_id, second.rows[0].document_id);
  assert.equal('content' in first.rows[0], false);
  store.close();
});

test('document-only maintenance persists and deletes without changing vectors', async t => {
  const directory = await fixture(t);
  let store = createVectorStore({ directory, dimensions: 2, model: 'stub-v1', autoCommit: false });
  store.recordDocuments([{ document_id: 'candidate:empty', source_hash: 'redacted' }]);
  store.commit(); const first = store.status().generation;
  assert.deepEqual(store.listDocuments(), [{ document_id: 'candidate:empty', source_hash: 'redacted' }]);
  store.removeDocuments(['candidate:empty']); store.commit();
  assert.notEqual(store.status().generation, first);
  assert.equal(store.status().documents, 0); store.close();
  store = createVectorStore({ directory, dimensions: 2, model: 'stub-v1', readOnly: true });
  assert.equal(store.status().documents, 0); store.close();
});

test('readers reuse a generation, detect corruption and refresh atomically', async t => {
  const directory = await fixture(t);
  let writer = createVectorStore({ directory, dimensions: 2, model: 'stub-v1' });
  writer.upsertChunks([chunk('a')], [[1, 0]]); writer.close();
  const reader = createVectorStore({ directory, dimensions: 2, model: 'stub-v1', readOnly: true });
  t.after(() => reader.close());
  const original = fs.readSync; let bytes = 0;
  fs.readSync = function (...args) { const n = original.apply(this, args); bytes += n; return n; };
  try { reader.refresh(); reader.search([1, 0]); reader.refresh(); assert.equal(bytes, 0); }
  finally { fs.readSync = original; }
  writer = createVectorStore({ directory, dimensions: 2, model: 'stub-v1' });
  writer.upsertChunks([chunk('b', 'c2', 'Unreal')], [[0, 1]]); writer.close();
  assert.equal(reader.refresh().changed, true);
  assert.equal(reader.search([0, 1])[0].candidate_id, 'c2');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const file = path.join(directory, manifest.database_file);
  const stamp = fs.statSync(file); fs.utimesSync(file, stamp.atime, new Date(stamp.mtimeMs + 2000));
  assert.throws(() => reader.assertCurrent(), { code: 'search_vector_corrupt' });
  reader.close();
});

test('unchanged maintenance does not copy a generation or load its ANN', async t => {
  const directory = await fixture(t);
  let store = createVectorStore({ directory, dimensions: 2, model: 'stub-v1' });
  store.upsertChunks([chunk('a')], [[1, 0]]); const documents = store.listDocuments(); store.close();
  const load = Index.prototype.load; const copy = fs.copyFileSync; let loads = 0; let copies = 0;
  Index.prototype.load = function (...args) { loads++; return load.apply(this, args); };
  fs.copyFileSync = function (...args) { copies++; return copy.apply(this, args); };
  try {
    store = createVectorStore({ directory, dimensions: 2, model: 'stub-v1', autoCommit: false });
    store.recordDocuments(documents); store.removeDocuments(['section:missing']); store.commit();
    assert.equal(loads, 0); assert.equal(copies, 0);
    store.upsertChunks([chunk('b', 'c2', 'Updated')], [[0, 1]]);
    assert.equal(loads, 1);
  } finally { store?.close(); Index.prototype.load = load; fs.copyFileSync = copy; }
});

test('mapped readers run in an owned process and release files when that process exits', async t => {
  const directory = await fixture(t);
  const writer = createVectorStore({ directory, dimensions: 2, model: 'stub-v1' });
  writer.upsertChunks([chunk('a')], [[1, 0]]); writer.close();
  const source = `import {createVectorStore} from ${JSON.stringify(new URL('../../server/search-vector-store.js', import.meta.url).href)}; const reader=createVectorStore({directory:process.argv[1],dimensions:2,model:'stub-v1',readOnly:true,memoryMap:true});if(!reader.status().memory_mapped||reader.search([1,0])[0].candidate_id!=='c1')process.exitCode=1; reader.close();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, directory], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  fs.rmSync(directory, { recursive: true, force: true });
});
