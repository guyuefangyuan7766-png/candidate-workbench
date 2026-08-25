import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  BookOpen,
  BriefcaseBusiness,
  Building2,
  Clock3,
  Database,
  ExternalLink,
  Eye,
  FileText,
  FolderKanban,
  GraduationCap,
  History,
  Link2,
  LockKeyhole,
  Mail,
  MapPin,
  MessageSquareText,
  Pencil,
  Phone,
  RotateCcw,
  Send,
  ShieldAlert,
  Target,
  Trash2,
  Unlink,
  UserRound,
  X,
} from "lucide-react";
import type {
  Candidate,
  CandidateActivity,
  CandidateDraft,
  CandidateNote,
  CandidateProfileSection,
  Position,
  TalentPool,
} from "../types";
import { candidateDisplayAge, candidateHireStatusText, formatDate, formatDateTime, hasHireInformation } from "../utils";
import { displayApplicantNumber, displayScalarValue, filterPlaceholderData, filterPlaceholderLines, hasVisibleProfileSection, isDisplayableValue, isInternalMetadataKey, visibleProfileSection } from "../profile-section-display";
import { CandidateAvatar } from "./CandidateAvatar";
import { CandidateAttachmentsPanel } from "./AttachmentWorkflow";
import { CandidateForm } from "./CandidateForm";

export type DrawerMode = "detail" | "create" | "edit" | null;
type DetailTab = "profile" | "resume" | "assessment" | "activity" | "advanced";

interface CandidateDrawerProps {
  mode: DrawerMode;
  candidate: Candidate | null;
  notes: CandidateNote[];
  activities: CandidateActivity[];
  onClose: () => void;
  onEdit: () => void;
  onSave: (draft: CandidateDraft) => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onAddNote: (content: string) => void;
  positions?: Position[];
  talentPools?: TalentPool[];
  busy?: boolean;
  positionBusy?: boolean;
  sensitiveBusy?: boolean;
  sensitiveLoaded?: boolean;
  onRevealSensitive?: () => void;
  onLinkPosition?: (positionId: string) => void;
  onUnlinkPosition?: (positionId: string) => void;
  onOpenPosition?: (position: Position) => void;
  onLinkTalentPool?: (poolId: string) => void;
  onUnlinkTalentPool?: (poolId: string) => void;
  onCandidateUpdated?: () => void;
  onCandidateCreated?: (candidateId: string) => void;
  pendingProfileSave?: boolean;
}

const EMPTY_POSITIONS: Position[] = [];
const EMPTY_POOLS: TalentPool[] = [];
const POSITION_STATUS_LABELS: Record<Position["status"], string> = {
  draft: "草稿",
  open: "招聘中",
  paused: "已暂停",
  closed: "已关闭",
};

const SECTION_LABELS: Record<string, string> = {
  education: "教育经历",
  experience: "工作经历",
  work_experience: "工作经历",
  project: "项目经历",
  internship: "实习经历",
  skill: "技能",
  campus: "校园经历",
  language: "语言能力",
  certificate: "证书",
  award: "奖励与荣誉",
  training: "培训经历",
  publication: "论文与作品",
  management: "管理经历",
  other: "补充资料",
};

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (Array.isArray(value)) return value.map(valueText).join("、");
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${key}：${valueText(item)}`)
    .join("；");
  return String(value);
}

function metadataRows(record: Record<string, unknown>, omitted: string[] = []) {
  const hidden = new Set(["raw_payload", "metadata", ...omitted]);
  return Object.entries(record).map(([key, value]) => [key, filterPlaceholderData(value)] as const)
    .filter(([key, value]) => !hidden.has(key) && !isInternalMetadataKey(key) && isDisplayableValue(value));
}

function MetadataList({ record, omitted }: { record: Record<string, unknown>; omitted?: string[] }) {
  const rows = metadataRows(record, omitted);
  if (!rows.length) return <p className="empty-copy">暂无可展示信息</p>;
  return <dl className="metadata-list">{rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{valueText(value)}</dd></div>)}</dl>;
}

function RawPayload({ payload }: { payload?: Record<string, unknown> | null }) {
  const visible = filterPlaceholderData(payload);
  if (!visible || Array.isArray(visible) || !isDisplayableValue(visible)) return null;
  return (
    <details className="raw-payload-disclosure">
      <summary>查看来源原始字段</summary>
      <MetadataList record={visible as Record<string, unknown>} />
    </details>
  );
}

export function CandidateDrawer({
  mode,
  candidate,
  notes,
  activities,
  onClose,
  onEdit,
  onSave,
  onArchive,
  onRestore,
  onDelete,
  onAddNote,
  positions = EMPTY_POSITIONS,
  talentPools = EMPTY_POOLS,
  busy = false,
  positionBusy = false,
  sensitiveBusy = false,
  sensitiveLoaded = false,
  onRevealSensitive,
  onLinkPosition,
  onUnlinkPosition,
  onOpenPosition,
  onLinkTalentPool,
  onUnlinkTalentPool,
  onCandidateUpdated,
  onCandidateCreated,
  pendingProfileSave = false,
}: CandidateDrawerProps) {
  const [tab, setTab] = useState<DetailTab>("profile");
  const [noteText, setNoteText] = useState("");
  const [selectedPositionId, setSelectedPositionId] = useState("");
  const [selectedPoolId, setSelectedPoolId] = useState("");

  useEffect(() => {
    setTab("profile");
    setNoteText("");
    setSelectedPositionId("");
    setSelectedPoolId("");
  }, [candidate?.id, mode]);

  const availablePositions = useMemo(() => {
    const linkedIds = new Set(candidate?.positions.map((position) => position.id) ?? []);
    return positions.filter((position) => !position.archived_at && !linkedIds.has(position.id))
      .sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
  }, [candidate?.positions, positions]);

  const availablePools = useMemo(() => {
    const linkedIds = new Set(candidate?.talent_pools.map((pool) => pool.id) ?? []);
    return talentPools.filter((pool) => !pool.archived_at && !linkedIds.has(pool.id))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }, [candidate?.talent_pools, talentPools]);

  const timeline = useMemo(() => {
    const notesById = new Map(notes.map((note) => [note.id, note]));
    const fieldLabels: Record<string, string> = {
      owner: "负责人", phone: "手机号", email: "邮箱", current_company: "当前公司",
      current_title: "当前职位", location: "所在地", tags: "标签", source: "有效来源",
      gender: "性别", birth_date: "出生日期", age: "年龄",
      highest_school: "最高学历学校", highest_major: "最高学历专业", job_seeking_status: "求职状态",
      hire_status: "入职状态", hire_date: "入职日期", hire_position: "入职职位",
    };
    return activities.map((activity) => {
      const noteId = typeof activity.metadata.note_id === "string" ? activity.metadata.note_id : "";
      const note = noteId ? notesById.get(noteId) : undefined;
      const fields = Array.isArray(activity.metadata.fields)
        ? activity.metadata.fields.filter((field): field is string => typeof field === "string") : [];
      const relatedName = [activity.metadata.position_title, activity.metadata.pool_name]
        .find((value): value is string => typeof value === "string") ?? "";
      return {
        ...activity,
        detail: note?.content ?? (fields.length ? `变更字段：${fields.map((field) => fieldLabels[field] ?? field).join("、")}` : relatedName),
        actor: note?.author ?? "本地用户",
        tone: activity.type === "note_added" ? "note" : activity.type.includes("archived") ? "archived" : activity.type.includes("restored") ? "restored" : activity.type.includes("created") || activity.type.includes("imported") ? "created" : "updated",
      };
    });
  }, [activities, notes]);

  if (!mode) return null;
  const title = mode === "create" ? "新建候选人" : mode === "edit" ? "编辑候选人" : "候选人详情";

  function submitNote() {
    const value = noteText.trim();
    if (!value) return;
    onAddNote(value);
    setNoteText("");
  }

  const profileSections = (candidate?.profile_sections ?? []).filter((section): section is CandidateProfileSection => hasVisibleProfileSection(section)).map(visibleProfileSection);
  const assessments = candidate?.assessments ?? [];
  const preferences = candidate?.preferences;
  const displayAge = candidate ? candidateDisplayAge(candidate) : null;
  const applicantNumber = candidate?.source_system === "manual" ? "" : candidate?.source_record_id ?? "";
  const visibleApplicantNumber = displayApplicantNumber(candidate?.source_system, applicantNumber);
  const displayValue = (value: unknown) => displayScalarValue(value);
  const profilePhone = sensitiveLoaded ? displayValue(candidate?.phone) : "显式查看后显示";
  const profileEmail = sensitiveLoaded ? displayValue(candidate?.email) : "显式查看后显示";
  const profileLocation = displayValue(candidate?.location);
  const profileGender = displayValue(candidate?.gender);
  const profileAge = displayAge === null ? "" : `${displayAge} 岁`;
  const currentCompany = displayValue(candidate?.current_company);
  const currentTitle = displayValue(candidate?.current_title);
  const yearsExperience = candidate?.years_experience ? `${candidate.years_experience} 年` : "";
  const education = displayValue(candidate?.education);
  const school = displayValue(candidate?.highest_school);
  const major = displayValue(candidate?.highest_major);
  const selfSummary = displayValue(candidate?.self_summary);
  const jobStatus = displayValue(candidate?.job_seeking_status) || displayValue(preferences?.employment_status);
  const hireStatus = candidateHireStatusText(candidate?.hire_status);
  const hireDate = candidate?.hire_date ? formatDate(candidate.hire_date) : "";
  const hirePosition = displayValue(candidate?.hire_position);
  const desiredTitles = displayValue(preferences?.desired_titles);
  const desiredLocations = displayValue(preferences?.desired_locations);
  const employmentType = displayValue(preferences?.employment_type);
  const expectedSalary = sensitiveLoaded ? displayValue(preferences?.expected_salary) || displayValue(candidate?.expected_salary) : "敏感信息";
  const availability = displayValue(preferences?.availability);
  const hasContactSummary = Boolean(profilePhone || profileEmail || profileLocation);
  const hasIdentityDetails = Boolean(profileGender || profileAge || visibleApplicantNumber);
  const lineageRows = [
    { label: "来源系统", value: displayValue(candidate?.source_system) },
    { label: "源记录 ID", value: visibleApplicantNumber && sensitiveLoaded ? visibleApplicantNumber : visibleApplicantNumber ? "已保护" : "" },
    { label: "导入批次", value: displayValue(candidate?.import_batch_id) || (candidate?.source_system === "manual" ? "手工录入" : "") },
    { label: "创建日期", value: candidate?.created_at ? formatDate(candidate.created_at) : "" },
    { label: "简历更新", value: candidate?.resume_updated_at ? formatDate(candidate.resume_updated_at) : "" },
  ].filter((row) => isDisplayableValue(row.value));

  return (
    <div className="drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <aside className="drawer candidate-drawer talent-candidate-drawer" role="dialog" aria-modal="true" aria-label={title} aria-busy={busy || undefined}>
        <header className="drawer-header"><div><p className="drawer-kicker">{mode === "detail" ? "人才档案" : "候选人库"}</p><h2>{title}</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="关闭" title="关闭"><X size={19} /></button></header>

        {mode === "create" && <CandidateForm submitLabel={pendingProfileSave ? "重试保存偏好与履历" : "创建档案"} statusMessage={pendingProfileSave ? "候选人已创建，偏好或履历未完整保存。请重试，系统不会重复创建候选人。" : undefined} fieldsDisabled={pendingProfileSave} busy={busy} onCancel={onClose} onSubmit={onSave} />}
        {mode === "edit" && candidate && <CandidateForm initialValue={candidate} submitLabel="保存修改" busy={busy} onCancel={onClose} onSubmit={onSave} />}

        {mode === "detail" && candidate && (
          <>
            <div className="candidate-identity">
              <CandidateAvatar candidate={candidate} size="large" />
              <div className="candidate-identity-main">
                <div className="identity-title-row"><h3>{displayValue(candidate.name) || "未命名候选人"}</h3>{jobStatus && <span className="talent-status-badge">{jobStatus}</span>}</div>
                <p>{currentTitle || "职位待补充"}{currentCompany ? ` · ${currentCompany}` : ""}</p>
                <div className="identity-tags">{candidate.tags.map((tag) => displayValue(tag)).filter(Boolean).map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div>
              </div>
            </div>

            <div className="drawer-tabs talent-drawer-tabs" role="tablist" aria-label="候选人信息">
              <button className={tab === "profile" ? "active" : ""} type="button" onClick={() => setTab("profile")}>档案</button>
              <button className={tab === "resume" ? "active" : ""} type="button" onClick={() => setTab("resume")}>履历</button>
              <button className={tab === "assessment" ? "active" : ""} type="button" onClick={() => setTab("assessment")}>历史评估</button>
              <button className={tab === "activity" ? "active" : ""} type="button" onClick={() => setTab("activity")}>备注与动态</button>
              <button className={tab === "advanced" ? "active" : ""} type="button" onClick={() => setTab("advanced")}>高级信息</button>
            </div>

            <div className="drawer-scroll-region">
              {tab === "profile" && (
                <div className="profile-sections">
                  {(hasContactSummary || hasIdentityDetails || (!sensitiveLoaded && Boolean(onRevealSensitive))) && <section className="detail-section">
                    <div className="detail-section-heading"><h4>基本资料与联系方式</h4>{!sensitiveLoaded && <span className="protected-label"><LockKeyhole size={12} />敏感信息已保护</span>}</div>
                    <div className="info-list">
                      {profilePhone && <div><Phone size={16} /><span>{profilePhone}</span></div>}
                      {profileEmail && <div><Mail size={16} /><span>{profileEmail}</span></div>}
                      {profileLocation && <div><MapPin size={16} /><span>{profileLocation}</span></div>}
                    </div>
                    <dl className="detail-grid candidate-identity-details">
                      {profileGender && <div><dt><UserRound size={15} />性别</dt><dd>{profileGender}</dd></div>}
                      {profileAge && <div><dt><Clock3 size={15} />年龄</dt><dd>{profileAge}</dd></div>}
                      {applicantNumber && visibleApplicantNumber && <div className="candidate-applicant-id"><dt>应聘者编号</dt><dd>{visibleApplicantNumber}</dd></div>}
                    </dl>
                    {!sensitiveLoaded && onRevealSensitive && <button className="button sensitive-reveal-button" type="button" onClick={onRevealSensitive} disabled={sensitiveBusy}><Eye size={15} />{sensitiveBusy ? "正在加载..." : "查看敏感资料"}</button>}
                  </section>}

                  {(currentCompany || currentTitle || yearsExperience || education || school || major || selfSummary) && <section className="detail-section"><h4>当前经历与教育摘要</h4><dl className="detail-grid">
                    {currentCompany && <div><dt><Building2 size={15} />当前公司</dt><dd>{currentCompany}</dd></div>}
                    {currentTitle && <div><dt><BriefcaseBusiness size={15} />当前职位</dt><dd>{currentTitle}</dd></div>}
                    {yearsExperience && <div><dt><Clock3 size={15} />工作年限</dt><dd>{yearsExperience}</dd></div>}
                    {education && <div><dt><GraduationCap size={15} />最高学历</dt><dd>{education}</dd></div>}
                    {school && <div><dt>学校</dt><dd>{school}</dd></div>}{major && <div><dt>专业</dt><dd>{major}</dd></div>}
                  </dl>{selfSummary && <div className="self-summary"><strong>自我评价</strong><p>{selfSummary}</p></div>}</section>}

                  {(jobStatus || desiredTitles || desiredLocations || employmentType || expectedSalary || availability) && <section className="detail-section"><h4>求职偏好</h4><dl className="detail-grid">
                    {jobStatus && <div><dt><Target size={15} />求职状态</dt><dd>{jobStatus}</dd></div>}
                    {desiredTitles && <div><dt>期望职位</dt><dd>{desiredTitles}</dd></div>}
                    {desiredLocations && <div><dt>期望地点</dt><dd>{desiredLocations}</dd></div>}
                    {employmentType && <div><dt>工作性质</dt><dd>{employmentType}</dd></div>}
                    {expectedSalary && <div><dt>期望薪资</dt><dd>{expectedSalary}</dd></div>}
                    {availability && <div><dt>到岗时间</dt><dd>{availability}</dd></div>}
                  </dl></section>}

                  {hasHireInformation(candidate) && <section className="detail-section"><h4>入职信息</h4><dl className="detail-grid">
                    {hireStatus && <div><dt>入职状态</dt><dd>{hireStatus}</dd></div>}
                    {hireDate && <div><dt>入职日期</dt><dd>{hireDate}</dd></div>}
                    {hirePosition && <div><dt>入职职位</dt><dd>{hirePosition}</dd></div>}
                  </dl></section>}

                  <section className="detail-section candidate-position-section">
                    <div className="detail-section-heading"><h4>关联职位</h4><span>{candidate.positions.length} 个</span></div>
                    <div className="linked-position-list">{candidate.positions.map((position) => <div className={`linked-position-item${position.archived_at ? " is-archived" : ""}`} key={position.id}><span className="linked-position-icon"><BriefcaseBusiness size={16} /></span><div className="linked-position-main"><strong title={position.title}>{position.title}</strong><span>{[position.department, position.location].filter(Boolean).join(" · ") || "部门与地点未设置"}</span></div><span className={`position-status position-status-${position.status}`}>{position.archived_at ? "已归档" : POSITION_STATUS_LABELS[position.status]}</span><div className="linked-position-actions">{onOpenPosition && <button className="icon-button compact-icon-button" type="button" onClick={() => onOpenPosition(position)} aria-label={`打开职位 ${position.title}`} title="打开职位详情"><ExternalLink size={14} /></button>}{!candidate.archived_at && onUnlinkPosition && <button className="icon-button compact-icon-button" type="button" onClick={() => onUnlinkPosition(position.id)} disabled={positionBusy} aria-label={`解除与职位 ${position.title} 的关联`} title="解除关联"><Unlink size={14} /></button>}</div></div>)}</div>
                    {!candidate.positions.length && <div className="linked-position-empty"><BriefcaseBusiness size={18} /><span>尚未关联招聘职位</span></div>}
                    {!candidate.archived_at && onLinkPosition && availablePositions.length > 0 && <div className="position-link-control"><label><span className="sr-only">选择职位</span><select value={selectedPositionId} onChange={(event) => setSelectedPositionId(event.target.value)} disabled={positionBusy}><option value="">选择已有职位</option>{availablePositions.map((position) => <option key={position.id} value={position.id}>{position.title} · {POSITION_STATUS_LABELS[position.status]}</option>)}</select></label><button className="button secondary-button" type="button" onClick={() => selectedPositionId && onLinkPosition(selectedPositionId)} disabled={positionBusy || !selectedPositionId}><Link2 size={15} />关联职位</button></div>}
                  </section>

                  <section className="detail-section">
                    <div className="detail-section-heading"><h4>人才库与来源</h4><span>{candidate.talent_pools.length} 个分组</span></div>
                    <div className="linked-pool-list">{candidate.talent_pools.map((pool) => <div className="linked-pool-item" key={pool.id}><span className="pool-color" style={{ backgroundColor: pool.color }} /><div><strong>{pool.name}</strong><small>{pool.description || "人才库分组"}</small></div>{!candidate.archived_at && onUnlinkTalentPool && <button className="icon-button compact-icon-button" type="button" onClick={() => onUnlinkTalentPool(pool.id)} disabled={busy} aria-label={`从 ${pool.name} 移出`} title="移出人才库"><Unlink size={14} /></button>}</div>)}</div>
                    {!candidate.talent_pools.length && <div className="linked-position-empty"><FolderKanban size={18} /><span>尚未加入人才库</span></div>}
                    {!candidate.archived_at && onLinkTalentPool && availablePools.length > 0 && <div className="position-link-control"><label><span className="sr-only">选择人才库</span><select value={selectedPoolId} onChange={(event) => setSelectedPoolId(event.target.value)} disabled={busy}><option value="">选择人才库</option>{availablePools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name}</option>)}</select></label><button className="button secondary-button" type="button" onClick={() => selectedPoolId && onLinkTalentPool(selectedPoolId)} disabled={busy || !selectedPoolId}><FolderKanban size={15} />加入人才库</button></div>}
                    <dl className="detail-grid source-summary"><div><dt>有效来源</dt><dd>{candidate.source || "-"}</dd></div><div><dt><UserRound size={15} />人才负责人</dt><dd>{candidate.owner || "未分配"}</dd></div></dl>
                  </section>
                </div>
              )}

              {tab === "resume" && <div className="profile-sections"><section className="detail-section"><div className="detail-section-heading"><h4>完整履历</h4><span>{profileSections.length} 个资料模块</span></div>{profileSections.length ? <div className="resume-section-list">{profileSections.map((section) => { const content = filterPlaceholderLines(section.content); const structured = section.displayStructuredData; const title = filterPlaceholderLines(section.title) || SECTION_LABELS[section.section_type] || section.section_type; return <article className="resume-section-item" key={section.id}><header><span><BookOpen size={15} /></span><div><strong>{title}</strong><small>{SECTION_LABELS[section.section_type] || "来源资料"}</small></div>{section.sensitivity && section.sensitivity !== "normal" && <span className="sensitivity-chip">{section.sensitivity}</span>}</header>{content && <p>{content}</p>}{isDisplayableValue(structured) && <details><summary>查看结构化字段</summary><MetadataList record={Array.isArray(structured) ? { items: structured } : structured as Record<string, unknown>} /></details>}<RawPayload payload={section.raw_payload} /></article>; })}</div> : <div className="section-empty"><FileText size={22} /><span>暂无履历资料</span></div>}</section><CandidateAttachmentsPanel candidate={candidate} disabled={Boolean(candidate.archived_at)} onCandidateUpdated={onCandidateUpdated} onCandidateCreated={onCandidateCreated} /></div>}

              {tab === "assessment" && <div className="profile-sections"><section className="detail-section"><div className="detail-section-heading"><h4>历史评估</h4><span>{assessments.length} 条来源记录</span></div><p className="section-guidance">历史评估仅作为人才档案资料展示，不代表当前招聘流程状态。</p>{assessments.length ? <div className="assessment-list">{assessments.map((assessment) => <article className="assessment-item" key={assessment.id}><span className="assessment-icon"><History size={16} /></span><div><header><strong>{assessment.title || assessment.assessment_type || "历史评估"}</strong><time>{formatDateTime(assessment.occurred_at || assessment.assessed_at || assessment.created_at || null)}</time></header><div className="assessment-result">{assessment.conclusion || assessment.result || assessment.status || "结果未标注"}{assessment.score !== null && assessment.score !== undefined && <span>{assessment.score}</span>}</div>{(assessment.summary || assessment.conclusion) && <p>{assessment.summary || assessment.conclusion}</p>}<MetadataList record={assessment.metadata ?? {}} /><RawPayload payload={assessment.raw_payload} /></div></article>)}</div> : <div className="section-empty"><History size={22} /><span>暂无历史评估资料</span></div>}</section></div>}

              {tab === "activity" && <div className="activity-panel">{!candidate.archived_at && <div className="note-composer"><textarea value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder="添加候选人备注" rows={3} disabled={busy} /><button className="button small-primary-button" type="button" onClick={submitNote} disabled={busy || !noteText.trim()}><Send size={15} />添加备注</button></div>}<div className="timeline">{timeline.map((activity) => <div className="timeline-item" key={activity.id}><span className={`timeline-marker marker-${activity.tone}`}>{activity.tone === "note" ? <MessageSquareText size={13} /> : <Clock3 size={13} />}</span><div><div className="timeline-title"><strong>{activity.description}</strong><time>{formatDateTime(activity.created_at)}</time></div>{activity.detail && <p>{activity.detail}</p>}<span className="timeline-actor">{activity.actor}</span></div></div>)}{!timeline.length && <p className="empty-copy">暂无动态</p>}</div></div>}

              {tab === "advanced" && <div className="profile-sections advanced-sections">
                <section className="detail-section sensitive-section"><div className="sensitive-section-heading"><span><ShieldAlert size={18} /></span><div><h4>高级与敏感信息</h4><p>仅在明确进入本区域并主动加载后显示。列表、搜索和 AI 助手默认不可见。</p></div></div>{!sensitiveLoaded ? <button className="button sensitive-reveal-button" type="button" onClick={onRevealSensitive} disabled={sensitiveBusy || !onRevealSensitive}><Eye size={15} />{sensitiveBusy ? "正在安全加载..." : "加载完整敏感资料"}</button> : <div className="sensitive-loaded-state"><LockKeyhole size={15} /><span>敏感资料已在当前详情会话中加载</span></div>}</section>
                <section className="detail-section"><h4>数据血缘</h4><dl className="lineage-list">{lineageRows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl></section>
                <AdvancedRecordSection title="来源历史" icon={<Database size={16} />} records={candidate.source_records ?? []} sensitiveLoaded={sensitiveLoaded} />
                <AdvancedRecordSection title="职位申请来源" icon={<BriefcaseBusiness size={16} />} records={candidate.position_sources ?? []} sensitiveLoaded={sensitiveLoaded} />
                <AdvancedRecordSection title="授权与隐私记录" icon={<LockKeyhole size={16} />} records={candidate.consents ?? []} sensitiveLoaded={sensitiveLoaded} />
              </div>}
            </div>

            <footer className="drawer-footer detail-footer">
              {candidate.archived_at ? (
                <>
                  <button className="button danger-quiet-button permanent-delete-entry" type="button" onClick={onDelete} disabled={busy}><Trash2 size={16} />永久删除</button>
                  <span className="modal-footer-spacer" />
                  <button className="button secondary-button" type="button" onClick={onRestore} disabled={busy}><RotateCcw size={16} />恢复候选人</button>
                </>
              ) : (
                <>
                  <button className="button danger-quiet-button" type="button" onClick={onArchive} disabled={busy}><Archive size={16} />归档</button>
                  <button className="button primary-button" type="button" onClick={onEdit} disabled={busy}><Pencil size={16} />编辑</button>
                </>
              )}
            </footer>
          </>
        )}
      </aside>
    </div>
  );
}

function AdvancedRecordSection({ title, icon, records, sensitiveLoaded }: { title: string; icon: React.ReactNode; records: object[]; sensitiveLoaded: boolean }) {
  return <section className="detail-section"><div className="detail-section-heading"><h4 className="advanced-section-title">{icon}{title}</h4><span>{records.length} 条</span></div>{records.length ? <div className="advanced-record-list">{records.map((source, index) => { const record = source as Record<string, unknown>; const label = [record.title, record.position_title, record.agreement_name, record.record_type, record.source_name, record.consent_type, sensitiveLoaded ? record.source_application_id : undefined, sensitiveLoaded ? record.application_id : undefined].map(displayScalarValue).find(Boolean) || `${title} ${index + 1}`; return <details key={String(record.id ?? index)}><summary>{valueText(label)}</summary><MetadataList record={record} omitted={sensitiveLoaded ? undefined : ["source_application_id", "application_id"]} />{sensitiveLoaded && <RawPayload payload={record.raw_payload as Record<string, unknown> | null | undefined} />}</details>; })}</div> : <p className="empty-copy">暂无记录</p>}</section>;
}
