import { createApp } from './app.js'
import { loadEnvFile } from 'node:process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { configuredDatabasePath } from './database.js'
import { acquireRuntimeSentinel } from './maintenance.js'
import { parseAuthConfig, canBindHost } from './auth/config.js'
import { createAuthService } from './auth/index.js'

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
const authConfig = parseAuthConfig(process.env)
if (authConfig.enabled && authConfig.errors.length) {
  throw new Error(`认证配置无效：${authConfig.errors.join('；')}`)
}
const bindDecision = canBindHost(authConfig, host)
if (!bindDecision.allowed) {
  throw new Error(
    `拒绝监听 ${host}：本服务设计为通过反向代理访问，默认只监听回环地址（127.0.0.1、localhost、::1）。` +
    `如果确实需要让应用直接对外监听，必须同时满足：${bindDecision.reasons.join('；')}。` +
    `推荐做法是让 nginx 等反向代理终止 TLS 后转发到 127.0.0.1，而不是把应用绑到 0.0.0.0。`
  )
}
if (host.toLowerCase() !== 'localhost' && !/^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/.test(host)) {
  throw new Error('HOST 必须是字面 IP 地址，不接受主机名')
}
if (authConfig.warnings.length) {
  for (const warning of authConfig.warnings) console.warn(`[auth] ${warning}`)
}
if (!['127.0.0.1', 'localhost', '::1'].includes(host.toLowerCase()) && !authConfig.session.cookieSecure) {
  console.warn('[auth] 非回环监听且 AUTH_COOKIE_SECURE=false：会话 Cookie 将在明文 HTTP 上传输，请尽快启用 HTTPS')
}
const authService = authConfig.enabled ? createAuthService({ config: authConfig }) : null
if (authService) console.log(`[auth] ${authService.summary}`)
const runtimeSentinel = acquireRuntimeSentinel(configuredDatabasePath())
process.once('exit', () => runtimeSentinel.release())

let app
try {
  app = createApp(authService ? { auth: authService } : {})
} catch (error) {
  authService?.close()
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
        authService?.close()
        runtimeSentinel.release()
        process.exit(0)
      })
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
