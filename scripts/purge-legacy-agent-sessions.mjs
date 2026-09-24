#!/usr/bin/env node
/**
 * Delete AI conversations that predate session ownership.
 *
 * Rows created before the V14 migration have no user_id, so they belong to
 * nobody and are invisible to every user. This script removes them outright.
 *
 * Safe to run repeatedly: after the migration a NULL user_id can only come
 * from such legacy rows, so the count is 0 on a clean database.
 */
import { DatabaseSync } from 'node:sqlite'

const databasePath = process.argv[2] ?? process.env.DB_PATH ?? 'data/recruitment.db'
const apply = process.argv.includes('--apply')

const db = new DatabaseSync(databasePath)
try {
  // The service must be stopped: an exclusive lock here proves nothing else
  // holds a write transaction while we delete rows.
  const columns = db.prepare('PRAGMA table_info(agent_sessions)').all().map((c) => c.name)
  if (!columns.includes('user_id')) {
    console.error('agent_sessions.user_id 不存在：请先让服务启动一次以执行 V14 迁移。')
    process.exit(1)
  }

  const total = db.prepare('SELECT COUNT(*) AS c FROM agent_sessions').get().c
  const orphaned = db.prepare('SELECT COUNT(*) AS c FROM agent_sessions WHERE user_id IS NULL').get().c
  const messages = db.prepare(`
    SELECT COUNT(*) AS c FROM agent_messages
     WHERE session_id IN (SELECT id FROM agent_sessions WHERE user_id IS NULL)
  `).get().c

  console.log(`数据库        : ${databasePath}`)
  console.log(`会话总数      : ${total}`)
  console.log(`无归属(历史)  : ${orphaned}`)
  console.log(`其中消息数    : ${messages}`)

  if (orphaned === 0) {
    console.log('没有需要清理的历史会话。')
    process.exit(0)
  }

  if (!apply) {
    console.log('')
    console.log('这是预演。确认后加 --apply 执行删除：')
    console.log(`  node scripts/purge-legacy-agent-sessions.mjs "${databasePath}" --apply`)
    process.exit(0)
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    // agent_messages 与 agent_tasks 均以 ON DELETE CASCADE 引用会话，
    // 因此只删会话行即可连带清理消息、任务与摘要。
    const result = db.prepare('DELETE FROM agent_sessions WHERE user_id IS NULL').run()
    db.exec('COMMIT')
    console.log(`已删除 ${result.changes} 个历史会话（及其消息、任务、摘要）。`)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  const remaining = db.prepare('SELECT COUNT(*) AS c FROM agent_sessions').get().c
  const stillOrphaned = db.prepare('SELECT COUNT(*) AS c FROM agent_sessions WHERE user_id IS NULL').get().c
  console.log(`清理后会话总数: ${remaining}（无归属 ${stillOrphaned}）`)
} finally {
  db.close()
}
