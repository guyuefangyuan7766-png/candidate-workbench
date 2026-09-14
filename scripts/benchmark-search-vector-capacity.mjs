#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createVectorStore } from '../server/search-vector-store.js';

const option = name => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; };
const dimensions = Number(option('dimensions') ?? 512);
const count = Number(option('count') ?? 100000);
const mode = option('child');
const values = (id, n) => Array.from({ length: n }, (_, column) => Math.sin(id * 13 + column * 17));
const percentile = (items, fraction) => [...items].sort((a, b) => a - b)[Math.ceil(items.length * fraction) - 1];

if (!Number.isInteger(count) || count < 1 || count > 100000 || ![512, 1024].includes(dimensions)) throw new Error('Capacity arguments out of bounds');
if (mode === 'build') {
  const directory = option('directory');
  const started = performance.now();
  const store = createVectorStore({ directory, dimensions, model: 'synthetic-capacity', autoCommit: false });
  let peak = process.memoryUsage().rss;
  for (let offset = 0; offset < count; offset += 1000) {
    const chunks = []; const vectors = [];
    for (let n = offset; n < Math.min(count, offset + 1000); n++) {
      chunks.push({ id: String(n), candidate_id: `c${n}`, document_id: `d${n}`, source_type: 'candidate', source_id: `c${n}`, title: 'Anonymous', content: `Anonymous deterministic capacity vector ${n}`, source_hash: `h${n}` });
      vectors.push(values(n, dimensions));
    }
    store.upsertChunks(chunks, vectors); peak = Math.max(peak, process.memoryUsage().rss);
  }
  store.commit(); peak = Math.max(peak, process.memoryUsage().rss);
  const buildMs = performance.now() - started;
  const latency = [];
  for (let n = 0; n < 30; n++) { const start = performance.now(); store.search(values(n, dimensions), { k: 50 }); latency.push(performance.now() - start); }
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const result = { vectors: count, dimensions, build_ms: buildMs, query_samples: latency.length, query_ms_p50: percentile(latency, .5), query_ms_p95: percentile(latency, .95), sampled_peak_build_rss_bytes: peak, sqlite_bytes: fs.statSync(path.join(directory, manifest.database_file)).size, ann_bytes: fs.statSync(path.join(directory, manifest.index_file)).size };
  store.close(); console.log(JSON.stringify(result));
} else if (mode === 'read') {
  const started = performance.now(); const store = createVectorStore({ directory: option('directory'), dimensions, model: 'synthetic-capacity', readOnly: true });
  const openMs = performance.now() - started;
  const candidates = Array.from({ length: Math.min(count, 10000) }, (_, n) => `c${n}`); const query = values(0, dimensions); const latency = []; let peak = process.memoryUsage().rss;
  for (let n = 0; n < 10; n++) { const start = performance.now(); store.search(query, { candidateIds: candidates, k: 50 }); latency.push(performance.now() - start); peak = Math.max(peak, process.memoryUsage().rss); }
  store.close(); console.log(JSON.stringify({ cold_process_open_ms: openMs, filtered_vectors: candidates.length, filtered_samples: latency.length, filtered_query_ms_p50: percentile(latency, .5), filtered_query_ms_p95: percentile(latency, .95), sampled_peak_read_rss_bytes: peak }));
} else {
  async function runChild(childMode, n, directory) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', childMode, '--count', String(count), '--dimensions', String(n), '--directory', directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject); child.on('exit', code => { if (code !== 0) reject(new Error(`Capacity ${childMode} failed (${code}); ${stderr.slice(0, 500)}`)); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } });
    });
  }
  const report = { recorded_at: new Date().toISOString(), command: 'node scripts/benchmark-search-vector-capacity.mjs --count 100000 --output docs/evidence/search-vector-capacity.json', runtime: { node: process.version, platform: process.platform, architecture: process.arch, logical_cpus: os.cpus().length, total_memory_bytes: os.totalmem() }, methodology: { data: 'Generated deterministic numeric vectors; one unique fact and candidate per vector, Math.sin(id * 13 + dimension * 17). No model endpoint or candidate database is used.', index: 'USearch HNSW cosine Float32; connectivity 16; expansion_add/search 128', build_batch: 1000, embedding_cost_included: false, remote_calls: 0, query_k: 50, ann_vector_window: 1600, memory: 'RSS sampled after each build batch/commit and each read query; sampling can miss transient peaks.', cold: 'Fresh Node process; operating-system filesystem cache is not flushed.', limits: 'Capacity measurements only. Deterministic vectors have low intrinsic dimensionality; these results do not establish semantic quality, ANN recall or performance on production distributions.' }, measurements: [] };
  for (const n of [512, 1024]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beisen-anonymous-vector-capacity-'));
    try {
      const build = await runChild('build', n, directory); const read = await runChild('read', n, directory);
      report.measurements.push({ ...build, ...read }); console.log(JSON.stringify({ completed_dimensions: n, vectors: count }));
    } finally {
      if (path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('beisen-anonymous-vector-capacity-')) fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  const output = path.resolve(option('output') ?? 'docs/evidence/search-vector-capacity.json'); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log('Saved anonymous capacity report.');
}
