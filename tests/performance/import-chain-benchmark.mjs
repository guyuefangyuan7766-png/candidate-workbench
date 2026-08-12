#!/usr/bin/env node

/*
 * Reproducible candidate-import chain benchmark.
 *
 * The script always uses an explicitly supplied temporary database (or creates
 * one under the OS temp directory). It never opens data/recruitment.db.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createApp } from '../../server/app.js'

const DEFAULT_FILE = resolve(process.cwd(), '.tmp-import-benchmark', 'anonymous-8209-27.8mb.xlsx')

function parseArgs(argv) {
  const options = { file: DEFAULT_FILE, database: null, keep: false, dashboardIntervalMs: 100 }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--keep') options.keep = true
    else if (argument === '--file' || argument === '--database') {
      const value = argv[++index]
      if (!value) throw new Error(`${argument} requires a value`)
      options[argument.slice(2)] = resolve(value)
    } else if (argument === '--dashboard-interval-ms') {
      options.dashboardIntervalMs = Math.max(20, Number(argv[++index]))
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  if (!existsSync(options.file)) throw new Error(`Benchmark file does not exist: ${options.file}`)
  return options
}

async function jsonResponse(response) {
  const text = await response.text()
  return text ? JSON.parse(text) : null
}

async function waitForTask(baseUrl, taskId, samples, label) {
  let latest = null
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const started = performance.now()
    const response = await fetch(`${baseUrl}/api/candidates/import/tasks/${encodeURIComponent(taskId)}`)
    const body = await jsonResponse(response)
    samples.push({
      label,
      status: response.status,
      elapsed_ms: Number((performance.now() - started).toFixed(1))
    })
    if (!response.ok) throw new Error(`Task polling failed (${response.status})`)
    latest = body
    if (body?.terminal) return body
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(250, Math.max(25, Number(body?.poll_after_ms ?? 75)))))
  }
  throw new Error(`Task ${taskId} did not reach a terminal state`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const temporaryRoot = options.database ? null : mkdtempSync(join(tmpdir(), 'candidate-import-chain-'))
  const databasePath = options.database ?? join(temporaryRoot, 'benchmark.db')
  const uploadRoot = join(temporaryRoot ?? resolve(databasePath, '..'), 'uploads')
  const fileBuffer = readFileSync(options.file)
  const dashboardSamples = []
  const homepageSamples = []
  const taskSamples = []
  const maintenance = { close: async () => {}, status: () => ({ disabled: true }) }
  const app = createApp({
    databasePath,
    importUploadRoot: uploadRoot,
    importAsyncThresholdBytes: 1,
    importAsyncCommitRows: 1,
    searchMaintenanceService: maintenance,
    importTaskConcurrency: 1
  })
  const server = http.createServer(app)
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const sampleEndpoint = async (path, samples) => {
    const started = performance.now()
    try {
      const response = await fetch(`${baseUrl}${path}`)
      samples.push({
        status: response.status,
        elapsed_ms: Number((performance.now() - started).toFixed(1))
      })
      await response.arrayBuffer()
    } catch (error) {
      samples.push({ status: 0, elapsed_ms: Number((performance.now() - started).toFixed(1)), error: String(error?.code ?? error?.message ?? error) })
    }
  }
  let availabilitySampling = true
  const availabilityLoop = (async () => {
    while (availabilitySampling) {
      await Promise.all([
        sampleEndpoint('/api/dashboard', dashboardSamples),
        sampleEndpoint('/', homepageSamples)
      ])
      await new Promise((resolvePromise) => setTimeout(resolvePromise, options.dashboardIntervalMs))
    }
  })()

  const before = {
    file_bytes: fileBuffer.byteLength,
    database_bytes: existsSync(databasePath) ? statSync(databasePath).size : 0,
    wal_bytes: existsSync(`${databasePath}-wal`) ? statSync(`${databasePath}-wal`).size : 0,
    candidates: Number(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count),
    source_records: Number(app.locals.db.prepare('SELECT COUNT(*) AS count FROM candidate_source_records').get().count)
  }
  const uploadStarted = performance.now()
  const form = new FormData()
  form.append('file', new Blob([fileBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'anonymous-8209-27.8mb.xlsx')
  form.append('client_request_id', 'benchmark-preview-1')
  const uploadResponse = await fetch(`${baseUrl}/api/candidates/import/preview`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'benchmark-preview-1' },
    body: form
  })
  const uploadPayload = await jsonResponse(uploadResponse)
  const uploadAcceptedMs = Number((performance.now() - uploadStarted).toFixed(1))
  const previewTask = await waitForTask(baseUrl, uploadPayload.task_id, taskSamples, 'preview')
  const previewToken = previewTask.result?.preview_token
  if (!previewToken) throw new Error(`Preview task did not return a token: ${previewTask.status}`)

  const commitStarted = performance.now()
  const commitResponse = await fetch(`${baseUrl}/api/candidates/import/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'benchmark-commit-1' },
    body: JSON.stringify({ preview_token: previewToken, client_request_id: 'benchmark-commit-1' })
  })
  const commitPayload = await jsonResponse(commitResponse)
  const commitAcceptedMs = Number((performance.now() - commitStarted).toFixed(1))
  const commitTask = await waitForTask(baseUrl, commitPayload.task_id, taskSamples, 'commit')

  availabilitySampling = false
  await availabilityLoop
  const db = app.locals.db
  const after = {
    database_bytes: existsSync(databasePath) ? statSync(databasePath).size : 0,
    wal_bytes: existsSync(`${databasePath}-wal`) ? statSync(`${databasePath}-wal`).size : 0,
    candidates: Number(db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count),
    source_records: Number(db.prepare('SELECT COUNT(*) AS count FROM candidate_source_records').get().count),
    activities: Number(db.prepare('SELECT COUNT(*) AS count FROM activities').get().count),
    dirty_search_rows: Number(db.prepare('SELECT COUNT(*) AS count FROM search_index_dirty_v2').get().count)
  }
  const responseSummary = (samples) => {
    const durations = samples
      .filter((sample) => sample.status === 200)
      .map((sample) => sample.elapsed_ms)
      .sort((a, b) => a - b)
    const percentile = (fraction) => durations.length
      ? durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * fraction))]
      : null
    return {
      samples: samples.length,
      successful_samples: durations.length,
      p50_ms: percentile(0.5),
      p95_ms: percentile(0.95),
      max_ms: durations.length ? durations.at(-1) : null,
      errors: samples.filter((sample) => sample.status !== 200).length
    }
  }
  const result = {
    file: options.file,
    database: databasePath,
    upload: {
      status: uploadResponse.status,
      accepted_ms: uploadAcceptedMs,
      task_id: uploadPayload.task_id,
      metrics: previewTask.metrics
    },
    preview: {
      status: previewTask.status,
      phase: previewTask.phase,
      result_summary: previewTask.result?.summary ?? null,
      metrics: previewTask.metrics
    },
    commit: {
      status: commitTask.status,
      phase: commitTask.phase,
      accepted_ms: commitAcceptedMs,
      result: commitTask.result ?? null,
      metrics: commitTask.metrics
    },
    dashboard: responseSummary(dashboardSamples),
    homepage: responseSummary(homepageSamples),
    before,
    after,
    task_phase_samples: taskSamples.length
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  await app.closeDatabase()
  server.closeAllConnections()
  await new Promise((resolvePromise) => server.close(resolvePromise))
  if (temporaryRoot && !options.keep) rmSync(temporaryRoot, { recursive: true, force: true })
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`)
  process.exitCode = 1
})
