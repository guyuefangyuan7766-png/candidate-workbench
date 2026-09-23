import assert from 'node:assert/strict'
import test from 'node:test'
import { getResumeSearchOptions, searchCandidateResumes, searchCandidateResumesWithPlan } from '../../src/api.ts'

function response(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

test('search options consume every independent page and preserve option identity', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (path) => {
    const url = new URL(path, 'http://anonymous.invalid')
    calls.push(url.searchParams.get('page'))
    const page = Number(url.searchParams.get('page'))
    assert.equal(url.searchParams.get('kind'), 'position')
    assert.equal(url.searchParams.get('page_size'), '100')
    return response({ items: [{ id: `position-${page}`, name: `匿名职位 ${page}` }], pagination: { page, page_size: 100, total: 2, total_pages: 2, has_more: page < 2 } })
  })
  assert.deepEqual(await getResumeSearchOptions('position'), [{ id: 'position-1', name: '匿名职位 1' }, { id: 'position-2', name: '匿名职位 2' }])
  assert.deepEqual(calls, ['1', '2'])
})

test('search options reject repeated pages instead of returning silently incomplete choices', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response({ items: [{ id: 'pool-1', name: '匿名人才库' }], pagination: { page: 1, page_size: 100, total: 2, total_pages: 2, has_more: true } }))
  await assert.rejects(getResumeSearchOptions('talent_pool'), /完整读取/)
})

test('hybrid search sends the query in the POST body while preserving GET compatibility', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    calls.push({ path, init })
    return response({ items: [], pagination: { page: 1, page_size: 20, total: 0, has_more: false, next_cursor: null } })
  })
  await searchCandidateResumesWithPlan('上海 游戏策划 战斗系统', 2, 20, undefined, { archived: 'exclude', position_id: 'position-1' }, 'opaque-snapshot')
  assert.equal(calls[0].path, '/api/resume-search')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { q: '上海 游戏策划 战斗系统', archived: 'exclude', position_id: 'position-1', page_size: 20, cursor: 'opaque-snapshot' })
  await searchCandidateResumesWithPlan('上海 游戏策划 战斗系统', 1, 20, undefined, {}, 'opaque-first-page')
  assert.deepEqual(JSON.parse(calls[1].init.body), { q: '上海 游戏策划 战斗系统', page_size: 20, cursor: 'opaque-first-page' })
  await searchCandidateResumes('Unity', 1)
  assert.equal(calls[2].init.method, undefined)
  assert.match(calls[2].path, /^\/api\/resume-search\?q=Unity/)
})

test('explicit cancellation aborts the hybrid request without falling back or resubmitting', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', (_path, init) => new Promise((_resolve, reject) => {
    calls += 1
    init.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
  }))
  const controller = new AbortController()
  const pending = searchCandidateResumesWithPlan('Unity 不要外包', 1, 20, controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(calls, 1)
})
