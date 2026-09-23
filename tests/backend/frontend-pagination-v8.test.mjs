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
const grouped = source('src/views/CandidatesGroupedView.tsx')
const candidatesView = source('src/views/CandidatesView.tsx')

test('candidate, archive, all-record, and position pages render server pages instead of local slices', () => {
  assert.match(app, /candidateApi\.list\(\{ \.\.\.candidateListFilters, page: candidatePage, page_size: candidatePageSize \}, controller\.signal\)/)
  assert.match(app, /positionApi\.list\(\{ \.\.\.positionListFilters, page: positionPage, page_size: positionPageSize \}, controller\.signal\)/)
  assert.match(app, /const filteredCandidates = candidates;/)
  assert.match(app, /const visiblePositions = positions;/)
  assert.match(app, /<CandidatesView[\s\S]*pagination=\{candidatePagination\}[\s\S]*onPageChange=\{setCandidatePage\}/)
  assert.match(app, /<PositionsView[\s\S]*pagination=\{positionPagination\}[\s\S]*onPageChange=\{setPositionPage\}/)
  assert.match(app, /return \(\) => controller\.abort\(\);/)
  assert.doesNotMatch(app, /candidateApi\.listAll\(/)
  assert.doesNotMatch(api, /candidatesAll\s*\(/)
})

test('candidate page changes keep the current list mounted during loading and failed requests', () => {
  assert.match(app, /<CandidatesView[\s\S]*loading=\{candidateListLoading\}/)
  assert.match(candidatesView, /className="tw-table-region" aria-busy=\{loading\}/)
  assert.match(candidatesView, /loading && candidates\.length === 0 \? \([\s\S]*?className="tw-skeleton" aria-label="正在加载候选人"/)
  assert.doesNotMatch(app, /setCandidates\(\[\]\);\s*setCandidatePagination\(EMPTY_PAGINATION\);\s*setCandidateListError/)
  assert.doesNotMatch(app, /window\.scrollTo|scrollIntoView/)
})

test('talent-pool containers and members use independent server pagination', () => {
  assert.match(talentPools, /talentPoolApi\.list\(\{[\s\S]*page: poolPage,[\s\S]*page_size: poolPageSize/)
  assert.match(talentPools, /talentPoolApi\.candidates\(activePoolId, \{[\s\S]*page: memberPage,[\s\S]*page_size: memberPageSize/)
  assert.match(talentPools, /<EntityPagination pagination=\{poolPagination\}/)
  assert.match(talentPools, /setMemberPage\(Math\.max\(1, memberPagination\.page - 1\)\)/)
  assert.match(talentPools, /setMemberPage\(memberPagination\.page \+ 1\)/)
  assert.match(talentPools, /setSelectedPoolIds\(new Set\(\)\);[\s\S]*archiveMode, debouncedQuery, poolPage, poolPageSize/)
  assert.match(talentPools, /setSelectedIds\(new Set\(\)\);[\s\S]*memberPage, memberPageSize/)
  assert.doesNotMatch(talentPools, /talentPoolApi\.listAll\(|candidatesAll\(/)
})

test('talent-pool archive inventory is visible and keeps same-state bulk actions discoverable', () => {
  assert.match(talentPools, /useState<ArchiveMode>\("all"\)/)
  assert.match(talentPools, /className="tw-subnav-tabs" role="group" aria-label="人才库归档状态"/)
  assert.match(talentPools, /\[\["all", "全部"\], \["active", "使用中"\], \["archived", "已归档"\]\]/)
  assert.match(talentPools, /activePool\.archived_at && <span className="tw-status tw-status-archived">已归档<\/span>/)
  assert.match(talentPools, /toggleAllPools\("active", !allVisibleActivePoolsSelected\)/)
  assert.match(talentPools, /toggleAllPools\("archived", !allVisibleArchivedPoolsSelected\)/)
  assert.match(talentPools, /talentPoolApi\.restoreBatch/)
  assert.match(talentPools, /talentPoolApi\.permanentDeleteBatch/)
})

test('position members and candidate picker query only their requested server page', () => {
  assert.match(app, /positionApi\.candidates\(id, \{[\s\S]*page: positionCandidatePage,[\s\S]*page_size: positionCandidatePageSize/)
  assert.match(positionDetail, /pagination: Pagination/)
  assert.match(positionDetail, /onPageChange\(page - 1\)/)
  assert.match(positionDetail, /onPageChange\(page \+ 1\)/)
  assert.match(picker, /candidateApi\.list\(\{[\s\S]*exclude_position_id: excludePositionId,[\s\S]*exclude_pool_id: excludePoolId,[\s\S]*page,[\s\S]*page_size: pageSize/)
  assert.match(picker, /AbortController\(\)/)
  assert.match(picker, /选择当前页/)
})

test('candidate grouped view groups the current server page without scanning the full position catalog', () => {
  assert.match(grouped, /function buildGroups\(candidates: Candidate\[\]\)/)
  assert.match(grouped, /const byPosition = new Map<string, Group>\(\)/)
  assert.doesNotMatch(grouped, /positions\?: Position\[\]/)
  assert.doesNotMatch(grouped, /candidates\.filter\(\(candidate\) => candidate\.positions/)
  assert.doesNotMatch(app, /<TwGroupedCandidates[^>]*positions=/)
})

test('candidate filters use the complete lookup catalog while Agent opens candidates by ID', () => {
  assert.match(app, /positions=\{positionLookup\}/)
  assert.match(candidatesView, /\.\.\.positions\.map\(\(position\) => \(\{ value: position\.id, label: position\.archived_at \? `\$\{position\.title\}（已归档）` : position\.title \}\)\)/)
  assert.match(app, /async function openCandidateById\(candidateId: string, tab: DetailTab = "profile"\)/)
  assert.match(app, /<AssistantDrawer[\s\S]*onOpenCandidateId=\{\(candidateId, tab\) => void openCandidateById\(candidateId, tab \?\? "profile"\)\}/)
  assert.doesNotMatch(app, /<AssistantDrawer[^>]*onOpenCandidate=/)
})
