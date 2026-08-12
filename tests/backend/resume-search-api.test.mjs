import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.js'
import { insertCandidate } from '../../server/candidates.js'

async function requestJson(url) {
  const response = await fetch(url)
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}

test('resume-search HTTP route accepts boolean query strings and continues with a bound cursor', async () => {
  const app = createApp({ databasePath: ':memory:' })
  const server = http.createServer(app)
  try {
    for (let index = 0; index < 5; index += 1) {
      insertCandidate(app.locals.db, {
        name: `Anonymous HTTP resume candidate ${index}`,
        current_title: 'ResumeHttpMarkerV10'
      })
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const url = `http://127.0.0.1:${server.address().port}`

    const status = await requestJson(`${url}/api/resume-search/status`)
    assert.equal(status.response.status, 200)
    assert.equal(status.body.ready, true)
    assert.equal(status.body.search_index, 'candidate_resume_fts')

    const first = await requestJson(
      `${url}/api/resume-search?q=ResumeHttpMarkerV10&page_size=2&fast=true&include_total=false`
    )
    assert.equal(first.response.status, 200)
    assert.equal(first.body.items.length, 2)
    assert.equal(first.body.pagination.total, null)
    assert.equal(first.body.pagination.has_more, true)
    assert.ok(first.body.pagination.next_cursor)

    const second = await requestJson(
      `${url}/api/resume-search?q=ResumeHttpMarkerV10&page_size=2&fast=true&include_total=false&cursor=${encodeURIComponent(first.body.pagination.next_cursor)}`
    )
    assert.equal(second.response.status, 200)
    assert.equal(second.body.pagination.page, 2)
    assert.equal(new Set([...first.body.items, ...second.body.items].map((item) => item.candidate_id)).size, 4)

    const invalid = await requestJson(`${url}/api/resume-search?q=ResumeHttpMarkerV10&fast=yes`)
    assert.equal(invalid.response.status, 400)
    assert.equal(invalid.body.error.code, 'invalid_query')
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    await app.closeDatabase()
  }
})
