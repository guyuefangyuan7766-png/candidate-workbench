import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../../server/app.js'
import { openDatabase } from '../../server/database.js'
import { seedAnonymousSearch } from '../fixtures/anonymous-search.mjs'
const root = mkdtempSync(join(tmpdir(), 'shicai-browser-anonymous-'))
const databasePath = join(root, 'anonymous.db')
const seed = openDatabase(databasePath)
seedAnonymousSearch(seed)
seed.close()
const app = createApp({
  databasePath,
  searchRemoteEnabled: false,
  agentConfig: { baseUrl: '', apiKey: '', model: '' }
})
const server = app.listen(Number(process.argv[2] ?? 4397), '127.0.0.1', () =>
  console.log(`Anonymous preview http://127.0.0.1:${server.address().port}`)
)
const shutdown = () =>
  server.close(() => app.closeDatabase().finally(() => process.exit(0)))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
