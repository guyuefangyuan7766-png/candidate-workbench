import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  insertCandidate,
  listCandidateFacets,
  listCandidates
} from '../../server/candidates.js'
import { openDatabase } from '../../server/database.js'
import {
  insertPosition,
  linkCandidates,
  listPositionFacets,
  listPositions
} from '../../server/positions.js'
import {
  insertTalentPool,
  linkCandidatesToTalentPool,
  listTalentPools
} from '../../server/talent.js'

test('candidate, position, and talent-pool services use 20-row pages with reliable has_next metadata', () => {
  const db = openDatabase(':memory:')
  try {
    const candidates = []
    const positions = []
    const pools = []

    for (let index = 0; index < 23; index += 1) {
      candidates.push(insertCandidate(db, {
        name: `Pagination Candidate ${String(index).padStart(2, '0')}`,
        email: `pagination-${index}@example.test`,
        source: index % 2 ? 'Referral' : 'Import',
        owner: index % 3 ? 'Owner A' : 'Owner B',
        gender: index % 2 ? 'male' : 'female',
        tags: [index % 2 ? 'Frontend' : 'Backend']
      }))
      positions.push(insertPosition(db, {
        title: `Pagination Position ${String(index).padStart(2, '0')}`,
        status: index % 2 ? 'open' : 'draft',
        department: index % 2 ? 'Engineering' : 'Product',
        owner: index % 3 ? 'Owner A' : 'Owner B',
        location: index % 2 ? 'Shanghai' : 'Beijing'
      }))
      pools.push(insertTalentPool(db, {
        name: `Pagination Pool ${String(index).padStart(2, '0')}`,
        description: `Pool ${index}`
      }))
    }

    const candidateFirst = listCandidates(db, { archived: 'exclude', sort: 'name', order: 'asc' })
    const candidateSecond = listCandidates(db, { archived: 'exclude', sort: 'name', order: 'asc', page: 2 })
    assert.equal(candidateFirst.data.length, 20)
    assert.deepEqual(candidateFirst.pagination, { page: 1, page_size: 20, total: 23, total_pages: 2, has_next: true })
    assert.equal(candidateSecond.data.length, 3)
    assert.equal(candidateSecond.pagination.has_next, false)

    const positionFirst = listPositions(db, { archived: 'exclude', sort: 'title', order: 'asc' })
    const positionSecond = listPositions(db, { archived: 'exclude', sort: 'title', order: 'asc', page: 2 })
    assert.equal(positionFirst.data.length, 20)
    assert.deepEqual(positionFirst.pagination, { page: 1, page_size: 20, total: 23, total_pages: 2, has_next: true })
    assert.equal(positionSecond.data.length, 3)
    assert.equal(positionSecond.pagination.has_next, false)

    const poolFirst = listTalentPools(db, { archived: 'exclude', sort: 'name', order: 'asc' })
    const poolSecond = listTalentPools(db, { archived: 'exclude', sort: 'name', order: 'asc', page: 2 })
    assert.equal(poolFirst.data.length, 20)
    assert.deepEqual(poolFirst.pagination, { page: 1, page_size: 20, total: 23, total_pages: 2, has_next: true })
    assert.equal(poolSecond.data.length, 3)
    assert.equal(poolSecond.pagination.has_next, false)

    linkCandidates(db, positions[0].id, [candidates[0].id])
    linkCandidatesToTalentPool(db, pools[0].id, [candidates[0].id])
    const positionCandidatesExcluded = listCandidates(db, {
      archived: 'exclude',
      exclude_position_id: positions[0].id,
      page_size: 100
    })
    const poolCandidatesExcluded = listCandidates(db, {
      archived: 'exclude',
      exclude_pool_id: pools[0].id,
      page_size: 100
    })
    assert.equal(positionCandidatesExcluded.pagination.total, 22)
    assert.equal(positionCandidatesExcluded.data.some((candidate) => candidate.id === candidates[0].id), false)
    assert.equal(poolCandidatesExcluded.pagination.total, 22)
    assert.equal(poolCandidatesExcluded.data.some((candidate) => candidate.id === candidates[0].id), false)

    const candidateFacets = listCandidateFacets(db, { archived: 'include' })
    assert.deepEqual(candidateFacets.totals, { total: 23, active: 23, archived: 0 })
    assert.deepEqual(candidateFacets.sources, ['Import', 'Referral'])
    assert.deepEqual(candidateFacets.genders, ['female', 'male'])

    const positionFacets = listPositionFacets(db, { archived: 'include' })
    assert.deepEqual(positionFacets.totals, { total: 23, active: 23, archived: 0 })
    assert.equal(positionFacets.status_counts.open, 11)
    assert.equal(positionFacets.status_counts.draft, 12)
    assert.deepEqual(positionFacets.departments, ['Engineering', 'Product'])
  } finally {
    db.close()
  }
})
