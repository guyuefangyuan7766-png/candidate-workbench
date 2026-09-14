import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../../server/database.js'
import { readSearchDocuments } from '../../server/search-vector-source.js'
import { redactSearchText, readSearchIdentities } from '../../server/search-data-minimization.js'
import { buildVectorIndex } from '../../server/search-vector-maintenance.js'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { runVectorMaintenance, readVectorMaintenanceStatus, SearchVectorMaintenanceService } from '../../server/search-vector-maintenance-service.js'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anonymous-formal-maintenance-'))
  const db = openDatabase(path.join(directory, 'anonymous.sqlite'), { synchronizeSearch: false })
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { db, directory }
}

test('source keyset pages retain every live owned source once across source prefixes and explicit filters', t => {
  const { db } = fixture(t)
  const insert = db.prepare('INSERT INTO candidates(id,name,current_title,self_summary,created_at,updated_at) VALUES(?,?,?,?,?,?)')
  for (let n=0;n<31;n++) insert.run(`c${String(n).padStart(3,'0')}`,`Anonymous ${n}`,'Unity developer',`Builds systems ${n}`,'v1','v1')
  const section = db.prepare('INSERT INTO candidate_profile_sections(id,candidate_id,section_type,content,created_at,updated_at) VALUES(?,?,?,?,?,?)')
  for (let n=0;n<33;n++) section.run(`s${String(n).padStart(3,'0')}`,'c000','project',`Battle systems ${n}`,'v1','v1')
  section.run('unrelated','c000','other','Linked job wants secret robotics','v1','v1')
  db.prepare('UPDATE candidates SET archived_at=? WHERE id=?').run('v2','c030')
  db.prepare('UPDATE candidate_profile_sections SET archived_at=? WHERE id=?').run('v2','s032')
  const collected=[];let after=''
  for (;;) { const rows=readSearchDocuments(db,{limit:7,after}); if (!rows.length) break; collected.push(...rows); after=rows.at(-1).document_id }
  assert.equal(collected.length,62)
  assert.equal(new Set(collected.map(r=>r.document_id)).size,62)
  assert.deepEqual(collected.map(r=>r.document_id),collected.map(r=>r.document_id).sort())
  assert.ok(collected.every(r=>r.source_hash && !r.content.includes('secret')))
  assert.deepEqual(readSearchDocuments(db,{documentIds:['candidate:c001','section:s031']}).map(r=>r.document_id),['candidate:c001','section:s031'])
  assert.equal(readSearchDocuments(db,{candidateIds:['c001']}).length,1)
  assert.deepEqual(readSearchDocuments(db,{candidateIds:[]}),[])
})

test('outbound text masks local identities and contact labels while retaining qualifications and source offsets locally', t => {
  const { db }=fixture(t)
  db.prepare('INSERT INTO candidates(id,name,email,phone,current_title,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('anonymous-id','虚构甲','anon@example.invalid','13800138000','后端工程师','v1','v1')
  const identities=readSearchIdentities(db,['anonymous-id']).get('anonymous-id')
  const original='姓名：虚构甲\n上海 后端工程师 3到5年 Unity 或 Unreal\n电话：+86 138-0013-8000 邮箱：anon@example.invalid\n身份证：110101199001011234\n主页：https://example.invalid/private'
  const outbound=redactSearchText(original,{identities})
  assert.equal(outbound.includes('虚构甲'),false)
  assert.equal(outbound.includes('138'),false)
  assert.equal(outbound.includes('anon@'),false)
  assert.equal(outbound.includes('110101199001011234'),false)
  assert.equal(outbound.includes('example.invalid'),false)
  assert.ok(outbound.includes('上海 后端工程师 3到5年 Unity 或 Unreal'))
  assert.ok(original.includes('虚构甲'))
  const preserved=redactSearchText(original,{identities,preserveLength:true})
  assert.equal(preserved.length,original.length)
  assert.equal(preserved.includes('138'),false)
})

test('cancelled remote build resumes from durable embedding cache without publishing a partial generation', async t => {
  const {db,directory}=fixture(t)
  db.prepare('INSERT INTO candidates(id,name,current_title,created_at,updated_at) VALUES(?,?,?,?,?)').run('c1','Anonymous','Developer','v1','v1')
  const insert=db.prepare('INSERT INTO candidate_profile_sections(id,candidate_id,section_type,content,created_at,updated_at) VALUES(?,?,?,?,?,?)')
  for(let n=0;n<24;n++) insert.run(`s${String(n).padStart(2,'0')}`,'c1','skill',`Distinct anonymous skill ${n}`,'v1','v1')
  const index=path.join(directory,'index')
  const options={databasePath:path.join(directory,'anonymous.sqlite'),directory:index,dimensions:2,model:'anonymous-v1',concurrency:1,retries:0}
  let batches=0
  await assert.rejects(()=>buildVectorIndex({...options,embedTexts:async texts=>{if(++batches===2) throw new Error('synthetic outage');return texts.map(()=>[1,0])}}),/synthetic outage/)
  assert.equal(fs.existsSync(path.join(index,'manifest.json')),false)
  let resent=0
  const result=await buildVectorIndex({...options,embedTexts:async texts=>{resent+=texts.length;return texts.map(()=>[1,0])}})
  assert.equal(resent,15)
  assert.equal(result.cached_chunks,10)
  assert.equal(result.status.index_ready,true)
  let nextCalls=0
  const unchanged=await buildVectorIndex({...options,embedTexts:async()=>{nextCalls++;throw new Error('unchanged material must reuse active index')}})
  assert.equal(nextCalls,0)
  assert.equal(unchanged.status.generation,result.status.generation)
})

test('indexing masks identity across a chunk boundary and does not pin a source transaction during network calls',async t=>{
  const {db,directory}=fixture(t)
  const original='Unity '+ 'battle '.repeat(84) +'13800138000\nUnreal'
  db.prepare('INSERT INTO candidates(id,name,phone,self_summary,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('c1','虚构乙','13800138000',original,'v1','v1')
  const outbound=[];let wrote=false
  const result=await buildVectorIndex({databasePath:path.join(directory,'anonymous.sqlite'),directory:path.join(directory,'index'),dimensions:2,model:'anonymous-v1',embedTexts:async texts=>{
    outbound.push(...texts)
    if(!wrote){wrote=true;db.prepare('UPDATE candidates SET updated_at=? WHERE id=?').run('v2','c1');const checkpoint=db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();assert.equal(checkpoint.log,checkpoint.checkpointed)}
    return texts.map(()=>[1,0])
  }})
  assert.equal(outbound.some(text=>text.includes('13800138000') || text.includes('38000')),false)
  assert.equal(result.source_changed_during_build,true)
  assert.equal(db.prepare('SELECT self_summary FROM candidates WHERE id=?').get('c1').self_summary,original)
})

test('maintenance removes archived material and its durable cache while reusing remaining vectors', async t => {
  const {db,directory}=fixture(t)
  const insert=db.prepare('INSERT INTO candidates(id,name,current_title,created_at,updated_at) VALUES(?,?,?,?,?)')
  insert.run('c1','Anonymous one','Unity developer','v1','v1'); insert.run('c2','Anonymous two','Unreal developer','v1','v1')
  const index=path.join(directory,'index')
  const options={databasePath:path.join(directory,'anonymous.sqlite'),directory:index,dimensions:2,model:'anonymous-v1',embedTexts:async texts=>texts.map(()=>[1,0])}
  const first=await buildVectorIndex(options)
  db.prepare('UPDATE candidates SET archived_at=? WHERE id=?').run('v2','c1')
  const second=await buildVectorIndex({...options,embedTexts:async()=>{throw new Error('Unchanged surviving source must reuse vectors')}})
  assert.equal(second.removed_documents,1); assert.equal(second.status.documents,1); assert.notEqual(second.status.generation,first.status.generation)
  const cache=new DatabaseSync(path.join(index,'embedding-cache.sqlite'),{readOnly:true})
  try { assert.equal(cache.prepare('SELECT count(*) n FROM embeddings').get().n,1); assert.equal(cache.prepare('SELECT count(*) n FROM document_keys WHERE document_id=?').get('candidate:c1').n,0) } finally {cache.close()}
})

test('bounded retries and parallel batches publish aggregate status and sanitize failures', async t => {
  const {db,directory}=fixture(t)
  for(let n=0;n<35;n++) db.prepare('INSERT INTO candidates(id,name,current_title,created_at,updated_at) VALUES(?,?,?,?,?)').run(`c${n}`,'Anonymous',`Platform developer ${n}`,'v1','v1')
  const index=path.join(directory,'index')
  let active=0, maximum=0, calls=0
  const result=await runVectorMaintenance({databasePath:path.join(directory,'anonymous.sqlite'),directory:index,dimensions:2,model:'anonymous-v1',concurrency:2,retries:1,embedTexts:async texts=>{
    assert.ok(texts.length<=10); active++;maximum=Math.max(active,maximum);const number=++calls
    await new Promise(resolve=>setTimeout(resolve,5)); active--
    if(number===1) throw new Error('Synthetic transient error')
    return texts.map(()=>[1,0])
  }})
  assert.equal(maximum,2); assert.equal(result.retries,1); assert.equal(result.embedded_chunks,35)
  const before=readVectorMaintenanceStatus(index)
  assert.equal(before.state,'ready');assert.ok(before.last_success)
  db.prepare('UPDATE candidates SET current_title=? WHERE id=?').run('Different platform engineer','c0')
  await assert.rejects(()=>runVectorMaintenance({databasePath:path.join(directory,'anonymous.sqlite'),directory:index,dimensions:2,model:'anonymous-v1',retries:0,embedTexts:async()=>{throw new Error('synthetic-private-error-body')}}),{code:'search_vector_maintenance_failed'})
  const failed=readVectorMaintenanceStatus(index)
  assert.equal(failed.state,'failed'); assert.equal(failed.last_success,before.last_success)
  assert.equal(JSON.stringify(failed).includes('synthetic-private-error-body'),false)
})

test('disabled scheduling after close cannot launch a maintenance worker', async t=>{
  const {directory}=fixture(t)
  const service=new SearchVectorMaintenanceService({databasePath:path.join(directory,'anonymous.sqlite'),directory:path.join(directory,'index'),initialDelayMs:60000})
  await service.close();service.run()
  assert.equal(service.status().running,false)
  assert.equal(fs.existsSync(path.join(directory,'index')),false)
})

test('an abruptly killed maintenance child leaves a recoverable distinct-PID writer lock', { timeout: 15000 }, async t => {
  const { directory } = fixture(t)
  const index = path.join(directory, 'index')
  // The source is empty: no adapter request occurs and no material leaves this
  // test. Explicit dummy settings also prevent inherited gateway configuration.
  const service = new SearchVectorMaintenanceService({ databasePath: path.join(directory, 'anonymous.sqlite'), directory: index, dimensions: 2, model: 'anonymous-crash-v1', initialDelayMs: 60000, modelConfig: { baseUrl: 'https://example.invalid', apiKey: 'anonymous-only', embeddingModel: 'anonymous-crash-v1' } })
  const waitFor = async predicate => {
    const until = Date.now() + 10000
    while (!predicate()) {
      assert.ok(Date.now() < until, 'Maintenance child did not reach its expected state')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  try {
    service.run()
    const crashed = service.worker
    assert.ok(crashed?.pid && crashed.pid !== process.pid)
    const lockFile = path.join(index, '.build.lock')
    await waitFor(() => {
      try { return Number(fs.readFileSync(lockFile, 'utf8')) === crashed.pid }
      catch { return false }
    })
    const exited = new Promise(resolve => crashed.once('exit', resolve))
    crashed.kill('SIGKILL')
    await exited
    assert.equal(service.status().running, false)
    assert.equal(service.status().state, 'failed')
    assert.equal(service.status().error_code, 'search_vector_worker_exit')
    assert.equal(readVectorMaintenanceStatus(index).state, 'failed')
    assert.equal(readVectorMaintenanceStatus(index).error_code, 'search_vector_worker_exit')
    assert.equal(Number(fs.readFileSync(lockFile, 'utf8')), crashed.pid)
    assert.throws(() => process.kill(crashed.pid, 0), { code: 'ESRCH' })
    service.run()
    assert.notEqual(service.worker?.pid, crashed.pid)
    await waitFor(() => !service.worker)
    assert.equal(service.status().state, 'ready')
    assert.equal(service.status().status.documents, 0)
    assert.equal(fs.existsSync(lockFile), false)
    assert.equal(readVectorMaintenanceStatus(index).state, 'ready')
  } finally { await service.close() }
})

test('closing an active anonymous maintenance child preserves cancelled status in memory and on disk', { timeout: 15000 }, async t => {
  const { db, directory } = fixture(t)
  db.prepare('INSERT INTO candidates(id,name,current_title,created_at,updated_at) VALUES(?,?,?,?,?)').run('cancel-only', 'Anonymous cancel', 'Synthetic developer', 'v1', 'v1')
  let started
  const requestStarted = new Promise(resolve => { started = resolve })
  const server = createServer((_request, _response) => { started() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const index = path.join(directory, 'cancel-index')
  const service = new SearchVectorMaintenanceService({ databasePath: path.join(directory, 'anonymous.sqlite'), directory: index, initialDelayMs: 60000, retries: 0,
    modelConfig: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'anonymous-cancel-only', allowLoopbackForTests: true } })
  try {
    service.run()
    await requestStarted
    await service.close()
    assert.equal(service.status().running, false)
    assert.equal(service.status().state, 'cancelled')
    assert.equal(readVectorMaintenanceStatus(index).state, 'cancelled')
    assert.ok(!JSON.stringify(readVectorMaintenanceStatus(index)).includes('anonymous-cancel-only'))
  } finally {
    await service.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('a zero-exit child without a received terminal IPC message persists failed rather than starting', { timeout: 15000 }, async t => {
  const { directory } = fixture(t)
  const index = path.join(directory, 'missing-terminal-index')
  const service = new SearchVectorMaintenanceService({ databasePath: path.join(directory, 'anonymous.sqlite'), directory: index, dimensions: 2, model: 'anonymous-empty-v1', initialDelayMs: 60000,
    modelConfig: { baseUrl: 'https://example.invalid', apiKey: 'anonymous-only', embeddingModel: 'anonymous-empty-v1' } })
  try {
    service.run()
    const child = service.worker
    // Simulate a lost IPC delivery, not a fake child process. The empty anonymous
    // source exits normally and performs no model requests.
    child.removeAllListeners('message')
    const [code, signal] = await new Promise(resolve => child.once('exit', (...args) => resolve(args)))
    assert.equal(code, 0)
    assert.equal(signal, null)
    assert.equal(service.status().state, 'failed')
    assert.equal(readVectorMaintenanceStatus(index).state, 'failed')
    assert.equal(readVectorMaintenanceStatus(index).error_code, 'search_vector_worker_exit')
  } finally { await service.close() }
})
