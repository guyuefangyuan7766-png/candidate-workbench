import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pipeline = readFileSync(new URL('../../scripts/run-incremental-pipeline.mjs', import.meta.url), 'utf8')
const importer = readFileSync(new URL('../../scripts/import-incremental.mjs', import.meta.url), 'utf8')

test('incremental pipeline runs the agreed order and refuses to write while the service is up', () => {
  // 顺序：拉取 → 下载 → 导入 → 解析 → 附件文本 → 向量维护
  const order = ['check-manifest', 'download-shards', 'import-incremental', 'parse-origin-sections', 'persist-attachment-text', 'vector-maintenance']
  let cursor = -1
  for (const label of order) {
    const at = pipeline.indexOf(`run('${label}'`)
    assert.ok(at > cursor, `步骤顺序不符：${label}`)
    cursor = at
  }
  // 写库步骤前必须确认服务已停
  assert.match(pipeline, /要写库，但应用服务仍在运行/)
  assert.match(pipeline, /service_running/)
  // 子进程一律隐藏窗口
  assert.match(pipeline, /windowsHide: true/)
})

test('disappeared candidates are only marked is_deleted (never archived or deleted)', () => {
  assert.match(importer, /UPDATE candidate_asset_index SET is_deleted = 1 WHERE applicant_id = \?/)
  assert.match(importer, /removedMarked/)
  // Q3=B：不写 archived_at、不删候选人/附件
  assert.doesNotMatch(importer, /UPDATE candidates[\s\S]{0,80}archived_at\s*=/)
  assert.doesNotMatch(importer, /DELETE FROM candidates/)
})
