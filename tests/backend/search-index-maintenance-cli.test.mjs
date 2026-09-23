import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { insertCandidate } from '../../server/candidates.js'
import { backfillBusinessSearch } from '../../server/business-search.js'
import { openDatabase } from '../../server/database.js'

function runMaintenance(args, cwd) {
  return spawnSync(process.execPath, ['scripts/search-index-maintenance.mjs', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true
  })
}

test('search maintenance CLI is dry-run safe, reproducible, and source-bound', () => {
  const cwd = process.cwd()
  const directory = mkdtempSync(join(tmpdir(), 'candidate-search-maintenance-cli-'))
  const source = join(directory, 'source.db')
  const artifact = join(directory, 'artifact.db')
  const otherSource = join(directory, 'other.db')
  let db
  try {
    db = openDatabase(source)
    const candidate = insertCandidate(db, {
      name: 'Anonymous maintenance candidate',
      current_title: 'MaintenanceMarkerV8'
    })
    backfillBusinessSearch(db)
    const sourceCounts = {
      candidates: Number(db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count),
      activities: Number(db.prepare('SELECT COUNT(*) AS count FROM activities').get().count),
      documents: Number(db.prepare('SELECT COUNT(*) AS count FROM search_documents_v2').get().count)
    }
    db.close()
    db = null

    const dryRun = runMaintenance(['dry-run', '--database', source, '--json'], cwd)
    assert.equal(dryRun.status, 0, dryRun.stderr)
    const dry = JSON.parse(dryRun.stdout)
    assert.equal(dry.read_only, true)
    assert.equal(dry.mode, 'dry-run')
    assert.equal(dry.business_counts.candidates, sourceCounts.candidates)
    assert.ok(dry.estimated_required_bytes > 0)
    assert.ok(
      Object.keys(dry.derived_dbstat_bytes).some((name) => name.startsWith('sqlite_autoindex_search_documents_v2_')),
      `Derived dbstat omitted search document UNIQUE indexes: ${JSON.stringify(dry.derived_dbstat_bytes)}`
    )

    const build = runMaintenance([
      'build', '--database', source, '--output', artifact, '--no-vacuum', '--batch-size', '10', '--json'
    ], cwd)
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`)
    const report = JSON.parse(build.stdout)
    assert.equal(report.source_untouched, true)
    assert.equal(report.after.business_counts.candidates, sourceCounts.candidates)
    assert.equal(report.after.business_counts.activities, sourceCounts.activities)
    assert.equal(report.replay.stable, true)
    assert.equal(report.document_backfill.non_searchable_documents_deleted, 0)
    assert.ok(Number.isInteger(report.document_backfill.processed_rows))
    assert.ok(report.after.derived_dbstat_bytes)
    assert.ok(existsSync(`${artifact}.maintenance.json`))
    assert.ok(existsSync(`${artifact}.maintenance-state.json`))

    db = openDatabase(source, { synchronizeSearch: false })
    assert.deepEqual({
      candidates: Number(db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count),
      activities: Number(db.prepare('SELECT COUNT(*) AS count FROM activities').get().count),
      documents: Number(db.prepare('SELECT COUNT(*) AS count FROM search_documents_v2').get().count)
    }, sourceCounts)
    db.close()
    db = null

    db = openDatabase(otherSource, { synchronizeSearch: false })
    db.close()
    db = null
    const wrongResume = runMaintenance([
      'build', '--database', otherSource, '--output', artifact, '--resume', '--no-vacuum', '--json'
    ], cwd)
    assert.notEqual(wrongResume.status, 0)
    assert.match(`${wrongResume.stdout}\n${wrongResume.stderr}`, /database_missing|resume_source_mismatch/)

    assert.ok(report.representative_queries.some((probe) => probe.equivalent || probe.count_before === 0))
  } finally {
    try { db?.close() } catch {}
    rmSync(directory, { recursive: true, force: true })
  }
})
