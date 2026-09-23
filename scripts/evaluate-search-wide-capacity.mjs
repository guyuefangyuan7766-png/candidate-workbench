import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../server/database.js'
import { DatabaseSync } from 'node:sqlite'
import { createVectorStore, chunkResumeDocument, readSearchDocuments } from '../server/search-vector-store.js'
import { hybridSearch } from '../server/hybrid-search.js'
import { parseRuleQueryPlan } from '../server/search-query-plan.js'

// Numeric execution/capacity experiment only. It never opens a supplied DB or
// configures a remote model. The owning child exit releases mmap on Windows.
const count=20000
const query=Float32Array.from({length:1024},(_,i)=>i===0?1:0)
if(process.argv[2]==='--build-anonymous-child') {
  const root=process.argv[3]
  assert.ok(path.basename(root).startsWith('anonymous-wide-search-'))
  const db=openDatabase(path.join(root,'anonymous.db'),{synchronizeSearch:false})
  const insert=db.prepare('INSERT INTO candidates(id,name,current_title,self_summary,created_at,updated_at) VALUES(?,?,?,?,?,?)')
  db.exec('BEGIN')
  for(let i=0;i<count;i++) insert.run(`anonymous-${String(i).padStart(6,'0')}`,'匿名容量候选','Unity 工程师',i<5000?'Unity 外包':'Unity 数值系统','v1','v1')
  db.exec('COMMIT')
  const store=createVectorStore({directory:path.join(root,'vectors'),autoCommit:false})
  let after='';let peak=0
  for(;;){
    const docs=readSearchDocuments(db,{after,limit:200});if(!docs.length)break
    const chunks=docs.flatMap(doc=>chunkResumeDocument(doc))
    const vectors=chunks.map(chunk=>{
      const id=Number(chunk.candidate_id.slice(-6))
      const excluded=chunk.content.includes('外包')
      return Float32Array.from({length:1024},(_,i)=>i===0?1:(excluded?.001:.002)*Math.sin(id*13+i*17))
    })
    store.upsertChunks(chunks,vectors);after=docs.at(-1).document_id;peak=Math.max(peak,process.memoryUsage().rss)
  }
  const status=store.commit();peak=Math.max(peak,process.memoryUsage().rss)
  fs.writeFileSync(path.join(root,'build.json'),JSON.stringify({status,sampled_peak_rss_bytes:peak}))
  store.close();db.close()
} else if(process.argv[2]==='--query-anonymous-child') {
  const root=process.argv[3]
  assert.ok(path.basename(root).startsWith('anonymous-wide-search-'))
  const db=new DatabaseSync(path.join(root,'anonymous.db'),{readOnly:true})
  const start=performance.now()
  const store=createVectorStore({directory:path.join(root,'vectors'),readOnly:true,memoryMap:true})
  const openMs=performance.now()-start
  const plan=parseRuleQueryPlan('Unity 不要外包')
  const rows=[]
  let peak=process.memoryUsage().rss
  let snapshot
  for(let i=0;i<5;i++){
    const began=performance.now()
    const result=await hybridSearch(db,{plan,query:'Unity 不要外包',page_size:50,vectorStore:store,queryVector:query})
    assert.equal(result.pagination.total,15000)
    assert.equal(result.completeness.vector.mode,'ann')
    assert.ok(result.performance.vector_candidates>0)
    assert.ok(result.items.every(row=>Number(row.candidate_id.slice(-6))>=5000))
    assert.equal(result.degradation.length,0)
    peak=Math.max(peak,process.memoryUsage().rss)
    rows.push({elapsed_ms:performance.now()-began,vector_candidates:result.performance.vector_candidates,vector:result.completeness.vector,first_ids:result.items.map(row=>row.candidate_id)})
    snapshot=result._snapshot
  }
  const second=await hybridSearch(db,{plan,query:'Unity 不要外包',page:2,page_size:50,vectorStore:store,snapshot})
  assert.equal(new Set([...rows.at(-1).first_ids,...second.items.map(row=>row.candidate_id)]).size,100)
  fs.writeFileSync(path.join(root,'query.json'),JSON.stringify({open_ms:openMs,sampled_peak_rss_bytes:peak,memory_mapped:store.status().memory_mapped,pagination_unique:true,rows}))
  store.close();db.close()
} else {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'anonymous-wide-search-'))
  const script=fileURLToPath(import.meta.url)
  const started=Date.now()
  for(const phase of ['build','query']) {
    const result=spawnSync(process.execPath,[script,`--${phase}-anonymous-child`,root],{windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:180000,encoding:'utf8'})
    if(result.status!==0) throw new Error(`Anonymous ${phase} failed: ${result.stderr.slice(-1200)}`)
  }
  const size=directory=>fs.readdirSync(directory,{withFileTypes:true}).reduce((sum,entry)=>sum+(entry.isDirectory()?size(path.join(directory,entry.name)):fs.statSync(path.join(directory,entry.name)).size),0)
  const report={at:new Date().toISOString(),anonymous:true,remote_calls:0,candidates:count,qualified_candidates:15000,closer_excluded_candidates:5000,dimensions:1024,build:JSON.parse(fs.readFileSync(path.join(root,'build.json'))),query:JSON.parse(fs.readFileSync(path.join(root,'query.json'))),index_bytes:size(path.join(root,'vectors')),elapsed_ms:Date.now()-started,limitations:['Deterministic low-dimensional numeric vectors, not semantic quality or production distribution.','Fresh reader process with mmap; OS disk cache not flushed; RSS sampled after operations.','No remote planning or rerank in this local capacity experiment.']}
  fs.writeFileSync('docs/evidence/search-wide-anonymous-capacity.json',JSON.stringify(report,null,2))
  console.log(JSON.stringify({candidates:count,qualified:15000,queries:report.query.rows.map(row=>({ms:row.elapsed_ms,vector:row.vector})),peak_rss_bytes:report.query.sampled_peak_rss_bytes,index_bytes:report.index_bytes}))
}
