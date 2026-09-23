import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, request } from '../../src/api.ts'

test('frontend Agent request timeout covers a response body that stalls after headers', { timeout: 4_000 }, async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (_input, init = {}) => ({
      ok: true,
      status: 200,
      json: () => new Promise((resolve, reject) => {
        const signal = init.signal
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    await assert.rejects(
      request('/anonymous-body-stall', undefined, { timeoutMs: 1_000 }),
      (error) => error instanceof ApiError && error.status === 408 && error.code === 'request_timeout'
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('frontend Agent request still honors caller cancellation while reading a response body', { timeout: 2_000 }, async () => {
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  try {
    globalThis.fetch = async (_input, init = {}) => ({
      ok: true,
      status: 200,
      json: () => new Promise((resolve, reject) => {
        const signal = init.signal
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const pending = request('/anonymous-body-cancel', { signal: controller.signal }, { timeoutMs: 1_000 })
    setTimeout(() => controller.abort(), 20)
    await assert.rejects(pending, (error) => error?.name === 'AbortError')
  } finally {
    globalThis.fetch = originalFetch
  }
})
