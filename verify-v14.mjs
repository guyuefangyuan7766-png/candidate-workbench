import { DatabaseSync } from 'node:sqlite'

const path = process.argv[2] ?? 'C:/talent-data/recruitment.db'
const db = new DatabaseSync(path, { readOnly: true })
const one = (sql) => Object.values(db.prepare(sql).get())[0]
const has = (name) => Boolean(db.prepare('SELECT 1 AS x FROM sqlite_schema WHERE name = ?').get(name))

console.log('database        :', path)
console.log('schema_version  :', one('SELECT MAX(version) AS v FROM schema_migrations'))
console.log('has_user_id     :', db.prepare('PRAGMA table_info(agent_sessions)').all().map((c) => c.name).includes('user_id'))
console.log('has_user_index  :', has('agent_sessions_user_idx'))
console.log('sessions        :', one('SELECT COUNT(*) AS c FROM agent_sessions'))
console.log('messages        :', one('SELECT COUNT(*) AS c FROM agent_messages'))
console.log('tasks           :', one('SELECT COUNT(*) AS c FROM agent_tasks'))
console.log('orphan_sessions :', one('SELECT COUNT(*) AS c FROM agent_sessions WHERE user_id IS NULL'))
console.log('owned_sessions  :', one('SELECT COUNT(*) AS c FROM agent_sessions WHERE user_id IS NOT NULL'))
console.log('fk_issues       :', db.prepare('PRAGMA foreign_key_check').all().length)
db.close()
