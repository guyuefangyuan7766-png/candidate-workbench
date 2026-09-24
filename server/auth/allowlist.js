import { readFileSync } from 'node:fs'
import { normalizeUsername } from './store.js'

/**
 * Account allowlist backed by a plain text file.
 *
 * Environment variables are a startup-time snapshot in Node and cannot be
 * re-read without a restart, so the operator-facing control surface is a file
 * that the process polls. Missing file means "allowlist disabled"; an empty
 * file means "deny everyone" so that an accidental truncation fails closed.
 */
export class AccountAllowlist {
  constructor(options = {}) {
    this.path = options.path ?? ''
    this.bootstrapUsers = new Set((options.bootstrapUsers ?? []).map(normalizeUsername).filter(Boolean))
    this.reloadMs = Number.isInteger(options.reloadMs) && options.reloadMs >= 1_000 ? options.reloadMs : 30_000
    this.logger = options.logger ?? console
    this.entries = new Set()
    this.mode = 'disabled'
    this.lastLoadedAt = 0
    this.lastError = null
    this.#load({ initial: true })
    // Per-request reloads alone would leave a quiet deployment (or a freshly
    // added account) stuck on the startup list. The timer makes the documented
    // "at most 30 seconds" contract hold regardless of traffic.
    this.timer = setInterval(() => this.reloadIfStale(), this.reloadMs)
    this.timer.unref?.()
  }

  #load({ initial = false } = {}) {
    if (!this.path) {
      if (initial) {
        this.entries = new Set(this.bootstrapUsers)
        this.mode = this.bootstrapUsers.size ? 'enabled' : 'disabled'
      }
      this.lastLoadedAt = Date.now()
      return
    }
    let content = null
    try {
      content = readFileSync(this.path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        if (initial || this.mode !== 'enabled') {
          // Nobody has opted into an allowlist yet: fall back to the bootstrap
          // list, or to "unenforced" for deployments that never configured one.
          this.entries = new Set(this.bootstrapUsers)
          this.mode = this.bootstrapUsers.size ? 'enabled' : 'disabled'
          this.lastError = null
          this.lastLoadedAt = Date.now()
          return
        }
        // The list was already in force and has now disappeared. That is an
        // operator error, not a decision to open access: keep the last known
        // list and make the failure visible instead of silently allowing all.
        this.lastError = 'ENOENT'
        this.lastLoadedAt = Date.now()
        this.logger.warn?.('账号白名单文件消失（保留上一次名单，未放开访问）')
        return
      }
      // Fail safe: keep the previous list rather than opening access up.
      this.lastError = error?.code ?? 'read_failed'
      this.lastLoadedAt = Date.now()
      this.logger.warn?.(`账号白名单读取失败（保留上一次名单）：${this.lastError}`)
      if (initial && this.entries.size === 0) {
        this.entries = new Set(this.bootstrapUsers)
        this.mode = this.bootstrapUsers.size ? 'enabled' : 'disabled'
      }
      return
    }
    const parsed = new Set()
    for (const rawLine of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const line = rawLine.split('#')[0].trim()
      if (!line) continue
      const normalized = normalizeUsername(line)
      if (normalized) parsed.add(normalized)
    }
    this.entries = parsed
    this.mode = 'enabled'
    this.lastError = null
    this.lastLoadedAt = Date.now()
  }

  reloadIfStale(now = Date.now()) {
    if (now - this.lastLoadedAt < this.reloadMs) return false
    this.#load()
    return true
  }

  get enforced() {
    return this.mode === 'enabled'
  }

  allows(username) {
    if (!this.enforced) return true
    const normalized = normalizeUsername(username)
    return Boolean(normalized) && this.entries.has(normalized)
  }

  get size() {
    return this.entries.size
  }

  close() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  status() {
    return {
      mode: this.mode,
      enforced: this.enforced,
      path: this.path || null,
      size: this.entries.size,
      last_loaded_at: this.lastLoadedAt ? new Date(this.lastLoadedAt).toISOString() : null,
      reload_ms: this.reloadMs,
      last_error: this.lastError
    }
  }
}
