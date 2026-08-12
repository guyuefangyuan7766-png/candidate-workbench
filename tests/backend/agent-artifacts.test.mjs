import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createApp } from '../../server/app.js'
import { createAgentSessionService, taskArtifactsFromResult } from '../../server/agent-sessions.js'

async function listenApp(databasePath, exportRoot) {
  const app = createApp({
    databasePath,
    agentExportRoot: exportRoot,
    agentConfig: { baseUrl: '', apiKey: '', model: '' }
  })
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    app,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await app.closeDatabase()
    }
  }
}

function exportResult(exportId, overrides = {}) {
  return {
    tool_results: [{
      tool: 'export_query_results',
      source_type: 'database',
      result: {
        export_id: exportId,
        filename: 'Agent 查询结果.csv',
        mime_type: 'text/csv; charset=utf-8',
        row_count: 1,
        bytes: 31,
        download_url: `/api/agent/exports/${encodeURIComponent(exportId)}`,
        ...overrides
      }
    }]
  }
}

test('persisted Agent CSV artifact survives service restart and keeps attachment headers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-workbench-agent-artifact-'))
  const databasePath = join(root, 'artifact.db')
  const exportRoot = join(root, 'exports')
  const exportId = `agent-query-${randomUUID()}.csv`
  const csvBytes = Buffer.from('\uFEFFname,email\r\n匿名,anonymous@example.test\r\n', 'utf8')
  let first
  let second
  try {
    first = await listenApp(databasePath, exportRoot)
    mkdirSync(exportRoot, { recursive: true })
    writeFileSync(join(exportRoot, exportId), csvBytes)
    const sessions = createAgentSessionService(first.app.locals.db)
    const session = sessions.createSession({ title: 'Artifact fixture' })
    const turn = sessions.beginTurn(session.id, { message: 'Create an anonymous CSV', client_request_id: randomUUID() })
    const task = sessions.createTask(turn, { task_id: randomUUID(), trace_id: randomUUID() })
    sessions.updateTask(task.task_id, {
      status: 'completed',
      stage: 'completed',
      result: exportResult(exportId),
      tools_used: [{ name: 'export_query_results' }]
    })

    const taskResponse = await fetch(`${first.url}/api/agent/tasks/${task.task_id}`).then((response) => response.json())
    assert.deepEqual(taskResponse.task.artifacts, [{
      artifact_id: exportId,
      kind: 'file',
      filename: 'Agent 查询结果.csv',
      mime_type: 'text/csv; charset=utf-8',
      bytes: 31,
      download_url: `/api/agent/exports/${exportId}`
    }])
    await first.close()
    first = null

    second = await listenApp(databasePath, exportRoot)
    const response = await fetch(`${second.url}/api/agent/exports/${exportId}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^text\/csv;\s*charset=utf-8/i)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const disposition = response.headers.get('content-disposition') ?? ''
    assert.match(disposition, /^attachment;/i)
    assert.match(disposition, /filename\*=UTF-8''Agent%20%E6%9F%A5%E8%AF%A2%E7%BB%93%E6%9E%9C\.csv/i)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), csvBytes)
  } finally {
    if (first) await first.close()
    if (second) await second.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('arbitrary and dangerous URLs cannot become trusted Agent artifacts', () => {
  const exportId = `agent-query-${randomUUID()}.csv`
  assert.deepEqual(taskArtifactsFromResult(exportResult(exportId, { download_url: 'https://example.test/file.csv' })), [])
  assert.deepEqual(taskArtifactsFromResult(exportResult(exportId, { download_url: 'javascript:alert(1)' })), [])
  assert.deepEqual(taskArtifactsFromResult({
    tool_results: [{ tool: 'query_candidates', result: exportResult(exportId).tool_results[0].result }]
  }), [])
})
