import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { preserveAttachmentPreviewToken } from '../../src/attachment-preview-state.ts'
import {
  attachmentFieldLabel,
  attachmentSuggestionEvidence,
  attachmentValueText
} from '../../src/attachment-suggestion-display.ts'

const apiSource = readFileSync(new URL('../../src/api.ts', import.meta.url), 'utf8')
const workflowSource = readFileSync(new URL('../../src/components/AttachmentWorkflow.tsx', import.meta.url), 'utf8')
const batchWorkflowSource = readFileSync(new URL('../../src/components/AttachmentBatchWorkflow.tsx', import.meta.url), 'utf8')
const pickerSource = readFileSync(new URL('../../src/components/CandidatePickerDialog.tsx', import.meta.url), 'utf8')
const formSource = readFileSync(new URL('../../src/components/CandidateForm.tsx', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('../../src/types.ts', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8')
const prefillSource = readFileSync(new URL('../../src/attachment-candidate-prefill.ts', import.meta.url), 'utf8')
const suggestionDisplaySource = readFileSync(new URL('../../src/attachment-suggestion-display.ts', import.meta.url), 'utf8')

test('attachment UI derives missing identity copy from empty API values', () => {
  assert.match(workflowSource, /record\.identity\.phone \|\| "未提取"/)
  assert.match(workflowSource, /record\.identity\.email \|\| "未提取"/)
  assert.match(batchWorkflowSource, /record\.identity\.phone \|\| "未提取"/)
  assert.match(batchWorkflowSource, /record\.identity\.email \|\| "未提取"/)
  assert.match(workflowSource, /"pdf", "docx", "xlsx", "xlsm", "xls", "csv", "txt"/)
  assert.match(batchWorkflowSource, /"pdf", "docx", "xlsx", "xlsm", "xls", "csv", "txt", "zip"/)
})

test('attachment suggestion cards show localized structured values without contact evidence labels', () => {
  assert.match(suggestionDisplaySource, /email: "邮箱"/)
  assert.match(suggestionDisplaySource, /phone: "手机号"/)
  assert.equal(attachmentFieldLabel('email'), '邮箱')
  assert.equal(attachmentFieldLabel('phone'), '手机号')
  assert.equal(attachmentValueText('455786463@qq.com'), '455786463@qq.com')
  assert.equal(attachmentSuggestionEvidence('email', '电子邮箱：455786463@qq.com', '455786463@qq.com'), null)
  assert.equal(attachmentSuggestionEvidence('phone', '手机号：13800000000', '13800000000'), null)
  assert.equal(attachmentSuggestionEvidence('phone', '手机号：13800000000', '+8613800000000'), '原文：13800000000')
  assert.equal(attachmentSuggestionEvidence('current_company', '现任公司：匿名公司', '匿名公司'), '现任公司：匿名公司')
  assert.match(workflowSource, /attachmentFieldLabel\(suggestion\.field\)/)
  assert.match(workflowSource, /attachmentValueText\(suggestion\.value\)/)
  assert.match(batchWorkflowSource, /attachmentFieldLabel\(suggestion\.field\)/)
  assert.match(batchWorkflowSource, /attachmentValueText\(suggestion\.value\)/)
  assert.doesNotMatch(batchWorkflowSource, /<strong>\{suggestion\.field\}<\/strong>/)
  assert.doesNotMatch(batchWorkflowSource, /<small>\{suggestion\.evidence\}<\/small>/)
})

test('attachment batch polling survives unchanged snapshots and transient request failures', () => {
  assert.match(batchWorkflowSource, /const shouldPollBatch = batchNeedsPolling\(batch\)/)
  assert.match(batchWorkflowSource, /if \(batchNeedsPolling\(next\)\) schedule\(next\)/)
  assert.match(batchWorkflowSource, /schedule\(snapshot, retryDelay\)/)
  assert.match(batchWorkflowSource, /Math\.min\(10_000, normalDelay \* \(2 \*\* Math\.min\(failures, 4\)\)\)/)
  assert.match(batchWorkflowSource, /\[batch\?\.batch_id, shouldPollBatch\]/)
  assert.doesNotMatch(batchWorkflowSource, /\[batch\?\.updated_at, batch\?\.status\]/)
})

test('attachment preview polling retains the client token when a restarted service cannot reissue it', () => {
  const previous = { preview_token: 'client-held-token', status: 'parsing' }
  const recovered = preserveAttachmentPreviewToken(
    { preview_token: '', status: 'ready' },
    previous
  )
  assert.equal(recovered.preview_token, 'client-held-token')
  assert.equal(
    preserveAttachmentPreviewToken({ preview_token: 'new-token', status: 'ready' }, previous).preview_token,
    'new-token'
  )
  assert.match(workflowSource, /const nextWithToken = preserveAttachmentPreviewToken\(next, preview\)/)
})

test('attachment preview uses its async API lifecycle instead of the shared 20 second request budget', () => {
  assert.match(apiSource, /ATTACHMENT_UPLOAD_TIMEOUT_MS = 60_000/)
  assert.match(apiSource, /attachmentRequest<AttachmentPreview>[\s\S]*\/api\/attachments\/previews/)
  assert.match(workflowSource, /attachmentApi\.getPreview\(previewId, preview\.preview_token, controller\.signal\)/)
  assert.match(workflowSource, /previewPollDelay\(nextWithToken\)/)
  assert.match(typesSource, /poll_after_ms\?: number/)
})

test('attachment parsing reaches an explicit failure state with the server reason and recovery actions', () => {
  assert.match(workflowSource, /setError\(previewFailureMessage\(next\)\)/)
  assert.match(workflowSource, /next\.retryable === false \? "none" : "upload"/)
  assert.match(workflowSource, /重新获取状态/)
  assert.match(workflowSource, /重试当前文件/)
  assert.match(workflowSource, /重新选择文件/)
  assert.match(typesSource, /error_code\?: string[\s\S]*error\?: string[\s\S]*retryable\?: boolean/)
  assert.doesNotMatch(workflowSource, /请求暂时没有返回/)
})

test('unmatched attachment records reuse candidate search and creation flows', () => {
  assert.match(workflowSource, /<CandidatePickerDialog/)
  assert.match(workflowSource, /initialQuery=\{searchRecord \? parsedCandidateName\(searchRecord\) : ""\}/)
  assert.match(workflowSource, /candidateApi\.get\(selectedId, true\)/)
  assert.match(workflowSource, /setResolvedCandidates/)
  assert.match(workflowSource, /<CandidateForm[\s\S]*initialDraft=\{createInitialDraft\}/)
  assert.match(workflowSource, /requireContact=\{false\}/)
  assert.match(workflowSource, /fieldsDisabled=\{Boolean\(pendingCreatedCandidateId\)\}/)
  assert.match(workflowSource, /attachmentApi\.createCandidate\(/)
  assert.match(workflowSource, /selectCandidate\(recordId, selected, "created"\)/)
  assert.match(prefillSource, /export function candidateDraftFromAttachmentRecord/)
  assert.match(prefillSource, /export function parsedAttachmentCandidateName/)
  assert.match(pickerSource, /initialQuery\?: string/)
  assert.match(pickerSource, /candidate\.location/)
  assert.match(formSource, /initialDraft\?: Partial<CandidateDraft>/)
  assert.match(formSource, /requireContact && !draft\.phone\.trim\(\) && !draft\.email\.trim\(\)/)
  assert.match(formSource, /const educationOptions = Array\.from\(new Set\(\[\.\.\.EDUCATION_OPTIONS, draft\.education\]\.filter\(Boolean\)\)\)/)
  assert.match(formSource, /<option value="">未填写<\/option>\{educationOptions/)
})

test('batch unmatched records expose search and create without weakening conflict guards', () => {
  const fallbackStart = batchWorkflowSource.indexOf('{record.match.status === "not_found" && <div className="attachment-match-fallback">')
  assert.ok(fallbackStart > 0)
  const fallbackLine = batchWorkflowSource.slice(fallbackStart, batchWorkflowSource.indexOf('\n', fallbackStart))
  assert.match(fallbackLine, /选择候选人/)
  assert.match(fallbackLine, /创建新候选人/)
  assert.match(fallbackLine, /openCandidateCreate\(record\)/)
  assert.match(batchWorkflowSource, /function openCandidateCreate\(record: AttachmentPreviewRecord\)[\s\S]*record\.match\.status !== "not_found"/)
  assert.match(batchWorkflowSource, /if \(!record \|\| record\.match\.status !== "not_found"\) return/)
  assert.match(batchWorkflowSource, /\["identity_conflict", "multiple_matches"\][\s\S]*身份冲突已阻断，不能猜测、创建或覆盖候选人/)
  assert.match(batchWorkflowSource, /linkedCandidateIds=\{Object\.entries\(selections\)[\s\S]*recordId !== pickerRecordId/)
  assert.match(batchWorkflowSource, /initialQuery=\{pickerRecord \? parsedAttachmentCandidateName\(pickerRecord\) : ""\}/)
  assert.match(batchWorkflowSource, /initialDraft: candidateDraftFromAttachmentRecord\(record\)/)
  assert.match(batchWorkflowSource, /initialDraft=\{createContext\.initialDraft\}/)
  assert.match(batchWorkflowSource, /requireContact=\{false\}/)
  assert.match(batchWorkflowSource, /fieldsDisabled=\{Boolean\(pendingCreatedCandidateId\)\}/)
})

test('attachment candidate creation uses the dedicated avatar-aware API contract', () => {
  assert.match(typesSource, /interface AttachmentAvatarSuggestion[\s\S]*available: boolean[\s\S]*source:/)
  assert.match(formSource, /includeAttachmentAvatar: boolean/)
  assert.match(formSource, /attachmentAvatar\.source !== "explicit_url"/)
  assert.match(formSource, /useState\(\(\) => defaultAttachmentAvatarSelection\(attachmentAvatar\)\)/)
  assert.match(formSource, /外部头像地址，需手动确认使用/)
  assert.match(formSource, /type="checkbox" checked=\{includeAttachmentAvatar\}/)
  assert.match(formSource, /includeAttachmentAvatar: Boolean\(attachmentAvatar\?\.available && includeAttachmentAvatar\)/)
  assert.match(workflowSource, /attachmentAvatar=\{createRecord\.avatar\}/)
  assert.match(batchWorkflowSource, /avatar: record\.avatar/)
  assert.match(batchWorkflowSource, /attachmentAvatar=\{createContext\.avatar\}/)
  assert.match(workflowSource, /attachmentApi\.createCandidate\([\s\S]*options\.includeAttachmentAvatar/)
  assert.match(batchWorkflowSource, /attachmentBatchApi\.createCandidate\([\s\S]*options\.includeAttachmentAvatar/)
  assert.match(workflowSource, /record\.avatar\.source === "explicit_url"[\s\S]*创建时需确认是否使用/)
  assert.match(batchWorkflowSource, /record\.avatar\.source === "explicit_url"[\s\S]*创建时需确认是否使用/)
  assert.doesNotMatch(workflowSource, /candidateApi\.create\(/)
  assert.doesNotMatch(batchWorkflowSource, /candidateApi\.create\(/)
  assert.equal((apiSource.match(/include_avatar: includeAvatar/g) ?? []).length, 2)
  assert.equal((apiSource.match(/profile_sections: profileSections/g) ?? []).length, 2)
  assert.match(workflowSource, /profile_sections \?\? \[\][\s\S]*options\.includeAttachmentAvatar/)
  assert.match(batchWorkflowSource, /profile_sections \?\? \[\][\s\S]*options\.includeAttachmentAvatar/)
  assert.equal((workflowSource.match(/sections: source === "created" \? new Set\(\)/g) ?? []).length, 1)
  assert.equal((batchWorkflowSource.match(/sections: source === "created" \? new Set\(\)/g) ?? []).length, 1)
  assert.match(apiSource, /\/api\/attachment-batches\/\$\{encodeURIComponent\(batchId\)\}\/items\/\$\{encodeURIComponent\(itemId\)\}\/candidates/)
})

test('manual matching recalculates existing candidate diffs before confirmation', () => {
  assert.match(workflowSource, /candidateApi\.get\(selectedId, true\)/)
  assert.match(workflowSource, /defaultFieldsForCandidate\(record, candidate\)/)
  assert.match(workflowSource, /candidateBaselines\[record\.record_id\]/)
  assert.match(workflowSource, /candidateFieldValue\(candidateBaseline, suggestion\.field\)/)
  assert.match(workflowSource, /suggestionChangesCandidate\(candidateBaseline, field, suggestion\.value\)/)
  assert.match(workflowSource, /selected_fields: selectedFields/)
  assert.match(workflowSource, /与现有档案一致，不会提交更新/)
  assert.match(workflowSource, /selectCandidate\(recordId, selected, "created"\)/)
})

test('candidate creation refreshes the version without creating a duplicate on recovery', () => {
  const preferencesIndex = workflowSource.search(/await candidateApi\.updatePreferences\((?:created\.id|createdId), preferences\)/)
  const refreshedCandidateIndex = workflowSource.indexOf('const selected = await getCandidateWithRetry(createdId)')
  assert.ok(preferencesIndex > 0)
  assert.ok(refreshedCandidateIndex > preferencesIndex)
  assert.match(workflowSource, /if \(!createdId\) \{[\s\S]*attachmentApi\.createCandidate\(/)
  assert.match(workflowSource, /setPendingCreatedCandidateId\(created\.id\)/)
  assert.match(workflowSource, /pendingCreatedCandidateId \? "重新获取并选择" : "创建并选择"/)
  assert.match(apiSource, /\/api\/attachments\/previews\/\$\{encodeURIComponent\(previewId\)\}\/candidates/)
  assert.match(apiSource, /不会重复创建/)
})

test('batch creation persists profile sections and clears them from the follow-up confirmation', () => {
  const selectStart = batchWorkflowSource.indexOf('function selectCandidate(')
  const selectEnd = batchWorkflowSource.indexOf('async function chooseCandidate', selectStart)
  const selectSource = batchWorkflowSource.slice(selectStart, selectEnd)
  const createStart = batchWorkflowSource.indexOf('async function createCandidate(')
  const createEnd = batchWorkflowSource.indexOf('const duplicateCandidateIds', createStart)
  const createSource = batchWorkflowSource.slice(createStart, createEnd)
  assert.ok(selectStart > 0 && selectEnd > selectStart)
  assert.ok(createStart > 0 && createEnd > createStart)
  assert.match(selectSource, /candidateId: candidate\.id/)
  assert.match(selectSource, /source === "created"[\s\S]*new Set\(\)/)
  assert.match(selectSource, /defaultAttachmentFieldsForCandidate\(record, candidate\)/)
  assert.match(selectSource, /sections: source === "created" \? new Set\(\) : selection\.sections/)
  assert.match(createSource, /setPendingCreatedCandidateId\(created\.id\)/)
  assert.match(createSource, /onCandidateCreated\?\.\(created\.id\)/)
  assert.match(createSource, /const selected = await getCandidateWithRetry\(createdId\)[\s\S]*selectCandidate\(recordId, selected, "created"\)/)
  assert.match(createSource, /profile_sections \?\? \[\][\s\S]*options\.includeAttachmentAvatar/)
  assert.doesNotMatch(createSource, /attachmentBatchApi\.confirm\(/)
  assert.match(typesSource, /resolution\?: "created"/)
  assert.match(batchWorkflowSource, /record\.match\.resolution === "created"/)
  assert.match(batchWorkflowSource, /createdCandidateResolutions[\s\S]*getCandidateWithRetry\(candidateId\)/)
  assert.match(batchWorkflowSource, /candidateId: candidate\.id,[\s\S]*fields: new Set\(\),[\s\S]*sections: new Set\(\)/)
  assert.match(batchWorkflowSource, /record\.match\.resolution === "created" && !candidateBaseline/)
  assert.match(batchWorkflowSource, /candidateBaseline \?\? \(record\.match\.candidate\?\.id === selection\.candidateId/)
  assert.match(workflowSource, /record\.match\.resolution === "created"/)
})

test('ambiguous confirm, stale versions, polling terminal errors, and delete races have recovery guards', () => {
  assert.match(workflowSource, /isAmbiguousConfirmError\(requestError\)[\s\S]*recoverConfirmOutcome\(\)/)
  assert.match(workflowSource, /latest\.status === "confirmed"[\s\S]*completeConfirmation\(\)/)
  assert.match(workflowSource, /requestError\.code === "version_conflict"[\s\S]*setErrorRecovery\("upload"\)/)
  assert.match(workflowSource, /isTerminalClientError\(requestError\)[\s\S]*\[404, 409, 410\]/)
  assert.match(workflowSource, /workflowGenerationRef\.current !== generation/)
  assert.match(workflowSource, /系统不会重复提交/)
})

test('multi-record previews cannot force or duplicate candidate selection and creation prefills resume date', () => {
  assert.match(workflowSource, /preview\.records\.length === 1 && record\.match\.status === "not_found"/)
  assert.match(workflowSource, /duplicateCandidateIds\.has\(selectedId\)/)
  assert.match(workflowSource, /同一批附件记录不能重复关联同一候选人/)
  assert.match(prefillSource, /resume_updated_at: attachmentSuggestionText\(record, "resume_updated_at"\) \|\| null/)
  assert.match(workflowSource, /source === "existing" \? defaultFieldsForCandidate\(record, candidate\) : new Set\(\)/)
})

test('created candidates become the true field baseline without resubmitting persisted sections', () => {
  const selectStart = workflowSource.indexOf('function selectCandidate(')
  const selectEnd = workflowSource.indexOf('function openCandidateSearch', selectStart)
  const selectSource = workflowSource.slice(selectStart, selectEnd)
  assert.match(selectSource, /setCandidateBaselines\(\(current\) => \(\{ \.\.\.current, \[recordId\]: candidate \}\)\)/)
  assert.match(selectSource, /source === "existing" \? defaultFieldsForCandidate\(record, candidate\) : new Set\(\)/)
  assert.doesNotMatch(selectSource, /default_selected/)
  assert.match(selectSource, /sections: source === "created" \? new Set\(\) : current\.sections/)
  assert.match(workflowSource, /const candidateBaseline = candidateBaselines\[record\.record_id\]/)
  assert.match(prefillSource, /candidate\.preferences\?\.expected_salary \|\| candidate\.expected_salary/)
  assert.match(prefillSource, /profile_sections: attachmentProfileSectionDrafts\(record\)/)
})

test('saved attachments support confirmed, retryable, and idempotent deletion without hiding downloads', () => {
  assert.match(apiSource, /deleteAttachment\(attachmentId: string\)/)
  assert.match(apiSource, /`\/api\/attachments\/\$\{encodeURIComponent\(attachmentId\)\}`/)
  assert.match(apiSource, /\{ method: "DELETE" \}/)
  assert.match(typesSource, /interface CandidateAttachmentDeleteResult[\s\S]*deleted: true[\s\S]*cleanup_queued: boolean/)

  assert.match(workflowSource, /role="alertdialog"/)
  assert.match(workflowSource, /aria-labelledby="attachment-delete-title"/)
  assert.match(workflowSource, /附件记录、正文索引和物理文件将被清理/)
  assert.match(workflowSource, /候选人不会被删除，已经确认写入的字段和履历也不会回滚/)
  assert.match(workflowSource, /setAttachments\(\(current\) => current\.filter\(\(attachment\) => attachment\.id !== target\.id\)\)/)
  assert.match(workflowSource, /requestError instanceof ApiError && requestError\.status === 404[\s\S]*await load\(\)/)
  assert.match(workflowSource, /setDeleteError\(safeErrorMessage\(requestError, "附件删除失败，请稍后重试。"\)\)/)
  assert.match(workflowSource, /deleteError \? "重试删除" : "确认删除附件"/)
  assert.match(workflowSource, /disabled=\{disabled \|\| deletingAttachmentId !== null\}/)
  assert.match(workflowSource, /attachmentApi\.downloadUrl\(attachment\)/)
  assert.match(workflowSource, /onCandidateUpdated\?\.\(\)/)
  assert.match(stylesSource, /\.candidate-attachment-list article \{ grid-template-columns: 30px minmax\(0, 1fr\) 76px; \}/)
  assert.match(stylesSource, /\.candidate-attachment-list \.attachment-file-actions \{ width: 76px;[\s\S]*grid-template-columns: repeat\(2, 36px\); \}/)
})

test('deleting the attachment from the current confirmation clears only its stale success summary', () => {
  assert.match(workflowSource, /confirmedAttachmentIdsRef = useRef<Set<string>>\(new Set\(\)\)/)
  assert.match(workflowSource, /result\.attachment_ids \?\? result\.attachments\?\.map\(\(attachment\) => attachment\.id\) \?\? \[\]/)
  assert.match(workflowSource, /confirmedIds\.has\(deletedAttachment\.id\)[\s\S]*confirmedIds\.size === 0 && preview\.file\.sha256 === deletedAttachment\.sha256/)
  assert.match(workflowSource, /if \(matchesConfirmedAttachment\) resetCompletedWorkflow\(\)/)
  assert.match(workflowSource, /setDeletedAttachment\(\{ id: target\.id, sha256: target\.sha256 \}\)/)
  assert.match(workflowSource, /deletedAttachment=\{deletedAttachment\}/)
  assert.match(workflowSource, /onCommitted=\{\(candidateIds\) => \{[\s\S]*candidateIds\.includes\(candidate\.id\)[\s\S]*void load\(\)[\s\S]*onCandidateUpdated\?\.\(\)/)
  assert.match(workflowSource, /onClick=\{resetCompletedWorkflow\}/)
})

test('attachment intent-position suggestions map to candidate preferences instead of current title', () => {
  assert.match(suggestionDisplaySource, /desired_titles: "意向岗位"/)
  assert.match(prefillSource, /candidate\.preferences\?\.desired_titles \?\? \[\]/)
  assert.match(prefillSource, /desired_titles: desiredTitles/)
  assert.doesNotMatch(prefillSource, /current_title:\s*attachmentSuggestionText\(record, "desired_titles"\)/)
})
