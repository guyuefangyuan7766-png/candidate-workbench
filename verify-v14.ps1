$ErrorActionPreference = 'Continue'
$db = 'C:/talent-data/recruitment.db'

node -e @'
const { DatabaseSync } = require('node:sqlite')
const d = new DatabaseSync('C:/talent-data/recruitment.db', { readOnly: true })
const scalar = (sql) => Object.values(d.prepare(sql).get())[0]

console.log('schema 版本      :', scalar('SELECT MAX(version) AS v FROM schema_migrations'))
console.log('user_id 列       :', d.prepare('PRAGMA table_info(agent_sessions)').all().map(c => c.name).includes('user_id') ? '已添加' : '缺失')
console.log('用户索引         :', d.prepare("SELECT 1 AS x FROM sqlite_schema WHERE name = 'agent_sessions_user_idx'").get() ? '存在' : '缺失')
console.log('会话总数         :', scalar('SELECT COUNT(*) AS c FROM agent_sessions'))
console.log('无归属会话       :', scalar('SELECT COUNT(*) AS c FROM agent_sessions WHERE user_id IS NULL'))
console.log('有归属会话       :', scalar('SELECT COUNT(*) AS c FROM agent_sessions WHERE user_id IS NOT NULL'))
console.log('外键异常         :', d.prepare('PRAGMA foreign_key_check').all().length)
const tables = d.prepare("SELECT COUNT(*) AS c FROM sqlite_schema WHERE type = 'table'").get().c
console.log('表总数           :', tables)
d.close()
'@
