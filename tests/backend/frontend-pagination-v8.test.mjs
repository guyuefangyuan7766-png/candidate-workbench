import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

const app = source('src/App.tsx')
const api = source('src/api.ts')
const talentPools = source('src/components/TalentPoolPage.tsx')
const picker = source('src/components/CandidatePickerDialog.tsx')
const positionDetail = source('src/components/PositionDetailPage.tsx')
const grouped = source('src/components/CandidateGroupedView.tsx')

test('candidate, archive, all-record, and position pages render server pages instead of local slices', () => {
  assert.match(app, /candidateApi\.list\(\{ \.\.\.candidateListFilters, page: candidatePage, page_size: candidatePageSize \}, controller\.signal\)/)
  assert.match(app, /positionApi\.list\(\{ \.\.\.positionListFilters, page: positionPage, page_size: positionPageSize \}, controller\.signal\)/)
  assert.match(app, /const filteredCandidates = candidates;/)
  assert.match(app, /const visiblePositions = positions;/)
  assert.match(app, /<Pagination pagination=\{candidatePagination\}[\s\S]*onPageChange=\{setCandidatePage\}/)
  assert.match(app, /<Pagination pagination=\{positionPagination\}[\s\S]*onPageChange=\{setPositionPage\}/)
  assert.match(app, /return \(\) => controller\.abort\(\);/)
  assert.doesNotMatch(app, /candidateApi\.listAll\(/)
  assert.doesNotMatch(api, /candidatesAll\s*\(/)
})

test('candidate page changes keep the current list mounted during loading and failed requests', () => {
  assert.match(app, /className="candidate-list-region" aria-busy=\{candidateListLoading\}/)
  assert.match(app, /candidateListLoading && candidates\.length === 0 \? <CandidateListSkeleton \/>/)
  assert.doesNotMatch(app, /setCandidates\(\[\]\);\s*setCandidatePagination\(EMPTY_PAGINATION\);\s*setCandidateListError/)
  assert.doesNotMatch(app, /window\.scrollTo|scrollIntoView/)
})

test('talent-pool containers and members use independent server pagination', () => {
  assert.match(talentPools, /talentPoolApi\.list\(\{[\s\S]*page: poolPage,[\s\S]*page_size: poolPageSize/)
  assert.match(talentPools, /talentPoolApi\.candidates\(activePoolId, \{[\s\S]*page: memberPage,[\s\S]*page_size: memberPageSize/)
  assert.match(talentPools, /<EntityPagination pagination=\{poolPagination\}/)
  assert.match(talentPools, /<EntityPagination pagination=\{memberPagination\}/)
  assert.match(talentPools, /setSelectedPoolIds\(new Set\(\)\);[\s\S]*archiveMode, debouncedQuery, poolPage, poolPageSize/)
  assert.match(talentPools, /setSelectedIds\(new Set\(\)\);[\s\S]*memberPage, memberPageSize/)
  assert.doesNotMatch(talentPools, /talentPoolApi\.listAll\(|candidatesAll\(/)
})

test('position members and candidate picker query only their requested server page', () => {
  assert.match(app, /positionApi\.candidates\(id, \{[\s\S]*page: positionCandidatePage,[\s\S]*page_size: positionCandidatePageSize/)
  assert.match(positionDetail, /pagination: Pagination/)
  assert.match(positionDetail, /onPageChange\(pagination\.page - 1\)/)
  assert.match(positionDetail, /onPageChange\(pagination\.page \+ 1\)/)
  assert.match(picker, /candidateApi\.list\(\{[\s\S]*exclude_position_id: excludePositionId,[\s\S]*exclude_pool_id: excludePoolId,[\s\S]*page,[\s\S]*page_size: pageSize/)
  assert.match(picker, /AbortController\(\)/)
  assert.match(picker, /选择当前页/)
})

test('candidate grouped view groups the current server page without scanning the full position catalog', () => {
  assert.match(grouped, /function buildGroups\(candidates: Candidate\[\]\)/)
  assert.match(grouped, /groupsByPosition = new Map/)
  assert.doesNotMatch(grouped, /positions\?: Position\[\]/)
  assert.doesNotMatch(grouped, /candidates\.filter\(\(candidate\) => candidate\.positions/)
  assert.doesNotMatch(app, /<CandidateGroupedView[^>]*positions=/)
})

test('candidate filters use the complete lookup catalog while Agent opens candidates by ID', () => {
  assert.match(app, /positionLookup\.map\(\(position\) => <option/)
  assert.match(app, /async function openCandidateById\(candidateId: string\)/)
  assert.match(app, /<AssistantDrawer[\s\S]*onOpenCandidateId=\{\(candidateId\) => void openCandidateById\(candidateId\)\}/)
  assert.doesNotMatch(app, /<AssistantDrawer[^>]*onOpenCandidate=/)
})
