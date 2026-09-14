#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { runVectorMaintenance } from '../server/search-vector-maintenance-service.js'
import { configuredDatabasePath, DEFAULT_DATABASE_PATH } from '../server/database.js'

try {
  const { values } = parseArgs({ options: { database: { type: 'string' }, directory: { type: 'string' }, anonymous: { type: 'string' }, formal: { type: 'boolean', default: false }, dimensions: { type: 'string', default: '1024' }, concurrency: { type: 'string', default: '4' } }, strict: true })
  if (!values.database || !values.directory || (values.formal && values.anonymous)) throw new Error('Explicit mode and paths required')
  const databasePath = fs.realpathSync(values.database)
  const directory = path.resolve(values.directory)
  const dimensions = Number(values.dimensions); const concurrency = Number(values.concurrency)
  if (![512,1024].includes(dimensions) || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Invalid limits')
  // Require a dedicated child directory, never a database/file/root path.
  if (directory === path.parse(directory).root || directory === path.dirname(databasePath) || directory === databasePath || (fs.existsSync(directory) && !fs.statSync(directory).isDirectory())) throw new Error('Dedicated vector directory required')
  if (!values.formal) {
    const blocked = [DEFAULT_DATABASE_PATH, configuredDatabasePath()].map(value => path.resolve(value).toLowerCase())
    if (values.anonymous !== 'true' || blocked.includes(databasePath.toLowerCase()) || !/anonymous|synthetic|fixture/iu.test(path.basename(databasePath))) throw new Error('Anonymous fixture required')
    const marker = JSON.parse(fs.readFileSync(`${databasePath}.anonymous.json`, 'utf8'))
    if (marker.synthetic !== true || marker.source !== 'generated-fixture' || marker.contains_real_candidate_data !== false) throw new Error('Anonymous marker required')
  }
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort())
  let previous = 0
  await runVectorMaintenance({ databasePath, directory, dimensions, concurrency, model: process.env.SEARCH_EMBEDDING_MODEL ?? 'text-embedding-v4' }, { signal: controller.signal, onProgress: value => {
    if (Date.now() - previous >= 30_000 || value.state !== 'building') { console.log(JSON.stringify(value)); previous = Date.now() }
  } })
} catch (error) {
  console.error(JSON.stringify({ state: 'failed', error_code: /^search_[a-z_]+$/u.test(error?.code ?? '') ? error.code : 'search_vector_maintenance_rejected' }))
  process.exitCode = 1
}
