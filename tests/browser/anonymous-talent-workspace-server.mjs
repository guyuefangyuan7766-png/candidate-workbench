import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../../server/app.js'
import { openDatabase } from '../../server/database.js'
import { seedAnonymousTalentWorkspace } from '../fixtures/anonymous-talent-workspace.mjs'

// Writable anonymous preview for the talent-workspace redesign. Remote search
// and the agent gateway stay disabled; data lives in a temp directory.
const root = mkdtempSync(join(tmpdir(), 'shicai-talent-workspace-'))
const databasePath = join(root, 'anonymous.db')
const attachmentRoot = join(root, 'private', 'attachments')
const seed = openDatabase(databasePath)
seedAnonymousTalentWorkspace(seed, { attachmentRoot })
seed.close()
const app = createApp({
  databasePath,
  attachmentRoot,
  searchRemoteEnabled: false,
  agentConfig: { baseUrl: '', apiKey: '', model: '' }
})
const server = app.listen(Number(process.argv[2] ?? 4398), '127.0.0.1', () =>
  console.log(`Anonymous talent workspace http://127.0.0.1:${server.address().port} db=${databasePath}`)
)
const shutdown = () =>
  server.close(() => app.closeDatabase().finally(() => process.exit(0)))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
