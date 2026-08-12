import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { preserveAttachmentPreviewToken } from '../../src/attachment-preview-state.ts'

const apiSource = readFileSync(new URL('../../src/api.ts', import.meta.url), 'utf8')
const workflowSource = readFileSync(new URL('../../src/components/AttachmentWorkflow.tsx', import.meta.url), 'utf8')
const batchWorkflowSource = readFileSync(new URL('../../src/components/AttachmentBatchWorkflow.tsx', import.meta.url), 'utf8')
const pickerSource = readFileSync(new URL('../../src/components/CandidatePickerDialog.tsx', import.meta.url), 'utf8')
const formSource = readFileSync(new URL('../../src/components/CandidateForm.tsx', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('../../src/types.ts', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8')

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
  assert.match(workflowSource, /attachmentApi\.getPreview\(previewId, controller\.signal\)/)
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
  assert.match(workflowSource, /candidateApi\.create\(/)
  assert.match(workflowSource, /selectCandidate\(recordId, selected, "created"\)/)
  assert.match(pickerSource, /initialQuery\?: string/)
  assert.match(pickerSource, /candidate\.location/)
  assert.match(formSource, /initialDraft\?: Partial<CandidateDraft>/)
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
  const preferencesIndex = workflowSource.indexOf('await candidateApi.updatePreferences(created.id, preferences)')
  const refreshedCandidateIndex = workflowSource.indexOf('const selected = await getCandidateWithRetry(createdId)')
  assert.ok(preferencesIndex > 0)
  assert.ok(refreshedCandidateIndex > preferencesIndex)
  assert.match(workflowSource, /if \(!createdId\) \{[\s\S]*candidateApi\.create\(/)
  assert.match(workflowSource, /setPendingCreatedCandidateId\(created\.id\)/)
  assert.match(workflowSource, /pendingCreatedCandidateId \? "重新获取并选择" : "创建并选择"/)
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
  assert.match(workflowSource, /resume_updated_at: suggestionText\(record, "resume_updated_at"\) \|\| null/)
  assert.match(workflowSource, /source === "existing" \? defaultFieldsForCandidate\(record, candidate\) : new Set\(\)/)
})

test('created candidates become the true field baseline while section defaults are preserved', () => {
  const selectStart = workflowSource.indexOf('function selectCandidate(')
  const selectEnd = workflowSource.indexOf('function openCandidateSearch', selectStart)
  const selectSource = workflowSource.slice(selectStart, selectEnd)
  assert.match(selectSource, /setCandidateBaselines\(\(current\) => \(\{ \.\.\.current, \[recordId\]: candidate \}\)\)/)
  assert.match(selectSource, /source === "existing" \? defaultFieldsForCandidate\(record, candidate\) : new Set\(\)/)
  assert.doesNotMatch(selectSource, /default_selected/)
  assert.doesNotMatch(selectSource, /sections:/)
  assert.match(workflowSource, /const candidateBaseline = candidateBaselines\[record\.record_id\]/)
  assert.match(workflowSource, /candidate\.preferences\?\.expected_salary \|\| candidate\.expected_salary/)
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
  assert.match(workflowSource, /onCommitted=\{\(\) => \{ setDeletedAttachment\(null\); void load\(\); onCandidateUpdated\?\.\(\); \}\}/)
  assert.match(workflowSource, /onClick=\{resetCompletedWorkflow\}/)
})

test('attachment intent-position suggestions map to candidate preferences instead of current title', () => {
  assert.match(workflowSource, /desired_titles: "意向岗位"/)
  assert.match(workflowSource, /candidate\.preferences\?\.desired_titles \?\? \[\]/)
  assert.match(workflowSource, /desired_titles: desiredTitles/)
  assert.doesNotMatch(workflowSource, /current_title:\s*suggestionText\(record, "desired_titles"\)/)
})
