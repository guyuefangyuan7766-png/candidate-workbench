import { createApp } from './app.js'
import { loadEnvFile } from 'node:process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { configuredDatabasePath } from './database.js'
import { acquireRuntimeSentinel } from './maintenance.js'

try {
  loadEnvFile(resolve(process.cwd(), '.env'))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

// Keep workspace search switches attached to the application process even when
// the launcher is started from a detached PowerShell child.
const searchRuntimeNames = new Set([
  'SEARCH_REMOTE_ENABLED', 'SEARCH_QUERY_MODEL', 'SEARCH_QUERY_REASONING_EFFORT',
  'SEARCH_QUERY_TIMEOUT_MS', 'SEARCH_EMBEDDING_MODEL', 'SEARCH_EMBEDDING_DIMENSIONS',
  'SEARCH_RERANK_MODEL', 'SEARCH_VECTOR_DIRECTORY', 'SEARCH_VECTOR_MAINTENANCE_ENABLED',
  'SEARCH_VECTOR_MAINTENANCE_CONCURRENCY', 'SEARCH_VECTOR_MAINTENANCE_INTERVAL_MS'
])
try {
  const runtime = JSON.parse(readFileSync(resolve(process.cwd(), 'data/search-runtime.json'), 'utf8'))
  for (const [name, value] of Object.entries(runtime)) {
    if (!searchRuntimeNames.has(name) || typeof value !== 'string' || value.length > 1024) throw new Error('Invalid local search runtime setting.')
    process.env[name] = value
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
try {
  const gateway = new URL(process.env.AGENT_BASE_URL ?? '')
  if (gateway.protocol === 'https:' && gateway.hostname) {
    const trusted = String(process.env.SEARCH_MODEL_TRUSTED_PRIVATE_HOSTS ?? process.env.ATTACHMENT_TEXT_TRUSTED_PRIVATE_HOSTS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
    if (!trusted.includes(gateway.hostname.toLowerCase())) process.env.SEARCH_MODEL_TRUSTED_PRIVATE_HOSTS = [...trusted, gateway.hostname.toLowerCase()].join(',')
  }
} catch { /* model adapter performs the authoritative endpoint validation */ }

const port = Number.parseInt(process.env.PORT ?? '4173', 10)
const host = process.env.HOST ?? '127.0.0.1'
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1'])
if (!loopbackHosts.has(host.toLowerCase())) {
  throw new Error('个人版仅允许监听本机地址（127.0.0.1、localhost 或 ::1）')
}
const runtimeSentinel = acquireRuntimeSentinel(configuredDatabasePath())
process.once('exit', () => runtimeSentinel.release())

let app
try {
  app = createApp()
} catch (error) {
  runtimeSentinel.release()
  throw error
}

const server = app.listen(port, host, () => {
  console.log(`Recruitment API listening on http://${host}:${port}`)
})

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down`)
  server.close(() => {
    Promise.resolve(app.closeDatabase())
      .catch(() => undefined)
      .finally(() => {
        runtimeSentinel.release()
        process.exit(0)
      })
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
