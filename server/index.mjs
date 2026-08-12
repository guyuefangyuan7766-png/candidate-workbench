import { createApp } from './app.js'
import { loadEnvFile } from 'node:process'
import { resolve } from 'node:path'
import { configuredDatabasePath } from './database.js'
import { acquireRuntimeSentinel } from './maintenance.js'

try {
  loadEnvFile(resolve(process.cwd(), '.env'))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

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
