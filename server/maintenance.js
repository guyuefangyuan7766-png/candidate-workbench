import { createHash, randomUUID } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MAINTENANCE_SENTINEL_KIND = 'candidate-workbench-maintenance-v1'
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function databaseFingerprint(databasePath) {
  return createHash('sha256')
    .update(resolve(databasePath).replaceAll('\\', '/').toLowerCase())
    .digest('hex')
}

export function maintenanceSentinelPath(databasePath, root = PROJECT_ROOT) {
  return resolve(root, `.candidate-workbench-maintenance-${databaseFingerprint(databasePath).slice(0, 24)}.lock`)
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    return true
  }
}

function readSentinel(path) {
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return null
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function removeStaleRuntimeSentinel(path, sentinel) {
  if (sentinel?.kind !== MAINTENANCE_SENTINEL_KIND || sentinel.owner !== 'runtime' || processIsAlive(Number(sentinel.pid))) {
    return false
  }
  const current = readSentinel(path)
  if (current?.token !== sentinel.token || current?.owner !== 'runtime' || processIsAlive(Number(current.pid))) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

export function acquireRuntimeSentinel(databasePath, root = PROJECT_ROOT) {
  const path = maintenanceSentinelPath(databasePath, root)
  const token = randomUUID()
  const value = {
    kind: MAINTENANCE_SENTINEL_KIND,
    owner: 'runtime',
    token,
    pid: process.pid,
    database_fingerprint: databaseFingerprint(databasePath),
    started_at: new Date().toISOString()
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor = null
    try {
      descriptor = openSync(path, 'wx')
      writeSync(descriptor, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'))
      closeSync(descriptor)
      descriptor = null
      let released = false
      return {
        path,
        release() {
          if (released) return
          released = true
          const current = readSentinel(path)
          if (current?.kind === MAINTENANCE_SENTINEL_KIND && current.owner === 'runtime' && current.token === token) {
            try { unlinkSync(path) } catch {}
          }
        }
      }
    } catch (error) {
      if (descriptor !== null) {
        try { closeSync(descriptor) } catch {}
        const current = readSentinel(path)
        if (current?.token === token) {
          try { unlinkSync(path) } catch {}
        }
      }
      if (error?.code === 'EEXIST' && attempt === 0 && removeStaleRuntimeSentinel(path, readSentinel(path))) continue
      const blocked = new Error('数据库处于维护状态或已由另一个服务进程占用，当前服务不会启动')
      blocked.code = 'database_maintenance_active'
      blocked.sentinel_path = path
      throw blocked
    }
  }
  throw new Error('Unable to acquire the runtime maintenance sentinel.')
}

// Artifact rebuilds use the same path-derived lock format as the runtime.
// Unlike the runtime lock, a maintenance lock is never auto-reaped: an
// interrupted rebuild must be reviewed before another process resumes it.
export function acquireMaintenanceSentinel(databasePath, root = PROJECT_ROOT, { recoverStale = false } = {}) {
  const path = maintenanceSentinelPath(databasePath, root)
  const token = randomUUID()
  const value = {
    kind: MAINTENANCE_SENTINEL_KIND,
    owner: 'maintenance',
    token,
    pid: process.pid,
    database_fingerprint: databaseFingerprint(databasePath),
    started_at: new Date().toISOString()
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor = null
    try {
      descriptor = openSync(path, 'wx')
      writeSync(descriptor, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'))
      closeSync(descriptor)
      descriptor = null
      break
    } catch (error) {
      if (descriptor !== null) {
        try { closeSync(descriptor) } catch {}
      }
      const stale = readSentinel(path)
      if (
        error?.code === 'EEXIST' && attempt === 0 && recoverStale &&
        stale?.kind === MAINTENANCE_SENTINEL_KIND && stale.owner === 'maintenance' &&
        !processIsAlive(Number(stale.pid))
      ) {
        const current = readSentinel(path)
        if (current?.token === stale.token && current.owner === 'maintenance' && !processIsAlive(Number(current.pid))) {
          try { unlinkSync(path) } catch {}
          continue
        }
      }
      const blocked = new Error('数据库维护锁已存在，不能并发重建派生索引')
      blocked.code = error?.code === 'EEXIST' ? 'database_maintenance_active' : 'maintenance_sentinel_unavailable'
      blocked.sentinel_path = path
      throw blocked
    }
  }
  let released = false
  return {
    path,
    release() {
      if (released) return
      released = true
      const current = readSentinel(path)
      if (current?.kind === MAINTENANCE_SENTINEL_KIND && current.owner === 'maintenance' && current.token === token) {
        try { unlinkSync(path) } catch {}
      }
    }
  }
}
