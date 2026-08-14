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
  Position,
  TalentPool,
} from "../types";
import { candidateDisplayAge, formatDate, formatDateTime } from "../utils";
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
  return Object.entries(record).filter(([key, value]) => !hidden.has(key) && value !== null && value !== undefined && value !== "");
}

function MetadataList({ record, omitted }: { record: Record<string, unknown>; omitted?: string[] }) {
  const rows = metadataRows(record, omitted);
  if (!rows.length) return <p className="empty-copy">暂无可展示信息</p>;
  return <dl className="metadata-list">{rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{valueText(value)}</dd></div>)}</dl>;
}

function RawPayload({ payload }: { payload?: Record<string, unknown> | null }) {
  if (!payload || !Object.keys(payload).length) return null;
  return (
    <details className="raw-payload-disclosure">
      <summary>查看来源原始字段</summary>
      <MetadataList record={payload} />
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

  const profileSections = candidate?.profile_sections ?? [];
  const assessments = candidate?.assessments ?? [];
  const preferences = candidate?.preferences;
  const displayAge = candidate ? candidateDisplayAge(candidate) : null;
  const applicantNumber = candidate?.source_system === "manual" ? "" : candidate?.source_record_id ?? "";

  return (
    <div className="drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <aside className="drawer candidate-drawer talent-candidate-drawer" role="dialog" aria-modal="true" aria-label={title} aria-busy={busy || undefined}>
        <header className="drawer-header"><div><p className="drawer-kicker">{mode === "detail" ? "人才档案" : "候选人库"}</p><h2>{title}</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="关闭" title="关闭"><X size={19} /></button></header>

        {mode === "create" && <CandidateForm submitLabel="创建档案" busy={busy} onCancel={onClose} onSubmit={onSave} />}
        {mode === "edit" && candidate && <CandidateForm initialValue={candidate} submitLabel="保存修改" busy={busy} onCancel={onClose} onSubmit={onSave} />}

        {mode === "detail" && candidate && (
          <>
            <div className="candidate-identity">
              <CandidateAvatar candidate={candidate} size="large" />
              <div className="candidate-identity-main">
                <div className="identity-title-row"><h3>{candidate.name}</h3>{candidate.job_seeking_status && <span className="talent-status-badge">{candidate.job_seeking_status}</span>}</div>
                <p>{candidate.current_title || "职位待补充"}{candidate.current_company ? ` · ${candidate.current_company}` : ""}</p>
                <div className="identity-tags">{candidate.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div>
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
                  <section className="detail-section">
                    <div className="detail-section-heading"><h4>基本资料与联系方式</h4>{!sensitiveLoaded && <span className="protected-label"><LockKeyhole size={12} />敏感信息已保护</span>}</div>
                    <div className="info-list">
                      <div><Phone size={16} /><span>{sensitiveLoaded ? candidate.phone || "-" : "显式查看后显示"}</span></div>
                      <div><Mail size={16} /><span>{sensitiveLoaded ? candidate.email || "-" : "显式查看后显示"}</span></div>
                      <div><MapPin size={16} /><span>{candidate.location || "-"}</span></div>
                    </div>
                    <dl className="detail-grid candidate-identity-details">
                      <div><dt><UserRound size={15} />性别</dt><dd>{candidate.gender || "-"}</dd></div>
                      <div><dt><Clock3 size={15} />年龄</dt><dd>{displayAge === null ? "-" : `${displayAge} 岁`}</dd></div>
                      {applicantNumber && <div className="candidate-applicant-id"><dt>应聘者编号</dt><dd>{applicantNumber}</dd></div>}
                    </dl>
                    {!sensitiveLoaded && onRevealSensitive && <button className="button sensitive-reveal-button" type="button" onClick={onRevealSensitive} disabled={sensitiveBusy}><Eye size={15} />{sensitiveBusy ? "正在加载..." : "查看敏感资料"}</button>}
                  </section>

                  <section className="detail-section"><h4>当前经历与教育摘要</h4><dl className="detail-grid">
                    <div><dt><Building2 size={15} />当前公司</dt><dd>{candidate.current_company || "-"}</dd></div>
                    <div><dt><BriefcaseBusiness size={15} />当前职位</dt><dd>{candidate.current_title || "-"}</dd></div>
                    <div><dt><Clock3 size={15} />工作年限</dt><dd>{candidate.years_experience ? `${candidate.years_experience} 年` : "-"}</dd></div>
                    <div><dt><GraduationCap size={15} />最高学历</dt><dd>{candidate.education || "-"}</dd></div>
                    <div><dt>学校</dt><dd>{candidate.highest_school || "-"}</dd></div><div><dt>专业</dt><dd>{candidate.highest_major || "-"}</dd></div>
                  </dl>{candidate.self_summary && <div className="self-summary"><strong>自我评价</strong><p>{candidate.self_summary}</p></div>}</section>

                  <section className="detail-section"><h4>求职偏好</h4><dl className="detail-grid">
                    <div><dt><Target size={15} />求职状态</dt><dd>{candidate.job_seeking_status || preferences?.employment_status || "-"}</dd></div>
                    <div><dt>期望职位</dt><dd>{preferences?.desired_titles?.join("、") || "-"}</dd></div>
                    <div><dt>期望地点</dt><dd>{preferences?.desired_locations?.join("、") || "-"}</dd></div>
                    <div><dt>工作性质</dt><dd>{preferences?.employment_type || "-"}</dd></div>
                    <div><dt>期望薪资</dt><dd>{sensitiveLoaded ? preferences?.expected_salary || candidate.expected_salary || "-" : "敏感信息"}</dd></div>
                    <div><dt>到岗时间</dt><dd>{preferences?.availability || "-"}</dd></div>
                  </dl></section>

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

              {tab === "resume" && <div className="profile-sections"><section className="detail-section"><div className="detail-section-heading"><h4>完整履历</h4><span>{profileSections.length} 个资料模块</span></div>{profileSections.length ? <div className="resume-section-list">{profileSections.map((section) => <article className="resume-section-item" key={section.id}><header><span><BookOpen size={15} /></span><div><strong>{section.title || SECTION_LABELS[section.section_type] || section.section_type}</strong><small>{SECTION_LABELS[section.section_type] || "来源资料"}</small></div>{section.sensitivity && section.sensitivity !== "normal" && <span className="sensitivity-chip">{section.sensitivity}</span>}</header><p>{section.content || valueText(section.structured_data)}</p>{section.structured_data && <details><summary>查看结构化字段</summary><MetadataList record={Array.isArray(section.structured_data) ? { items: section.structured_data } : section.structured_data} /></details>}<RawPayload payload={section.raw_payload} /></article>)}</div> : <div className="section-empty"><FileText size={22} /><span>暂无履历资料</span></div>}</section><CandidateAttachmentsPanel candidate={candidate} disabled={Boolean(candidate.archived_at)} onCandidateUpdated={onCandidateUpdated} onCandidateCreated={onCandidateCreated} /></div>}

              {tab === "assessment" && <div className="profile-sections"><section className="detail-section"><div className="detail-section-heading"><h4>历史评估</h4><span>{assessments.length} 条来源记录</span></div><p className="section-guidance">历史评估仅作为人才档案资料展示，不代表当前招聘流程状态。</p>{assessments.length ? <div className="assessment-list">{assessments.map((assessment) => <article className="assessment-item" key={assessment.id}><span className="assessment-icon"><History size={16} /></span><div><header><strong>{assessment.title || assessment.assessment_type || "历史评估"}</strong><time>{formatDateTime(assessment.occurred_at || assessment.assessed_at || assessment.created_at || null)}</time></header><div className="assessment-result">{assessment.conclusion || assessment.result || assessment.status || "结果未标注"}{assessment.score !== null && assessment.score !== undefined && <span>{assessment.score}</span>}</div>{(assessment.summary || assessment.conclusion) && <p>{assessment.summary || assessment.conclusion}</p>}<MetadataList record={assessment.metadata ?? {}} /><RawPayload payload={assessment.raw_payload} /></div></article>)}</div> : <div className="section-empty"><History size={22} /><span>暂无历史评估资料</span></div>}</section></div>}

              {tab === "activity" && <div className="activity-panel">{!candidate.archived_at && <div className="note-composer"><textarea value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder="添加候选人备注" rows={3} disabled={busy} /><button className="button small-primary-button" type="button" onClick={submitNote} disabled={busy || !noteText.trim()}><Send size={15} />添加备注</button></div>}<div className="timeline">{timeline.map((activity) => <div className="timeline-item" key={activity.id}><span className={`timeline-marker marker-${activity.tone}`}>{activity.tone === "note" ? <MessageSquareText size={13} /> : <Clock3 size={13} />}</span><div><div className="timeline-title"><strong>{activity.description}</strong><time>{formatDateTime(activity.created_at)}</time></div>{activity.detail && <p>{activity.detail}</p>}<span className="timeline-actor">{activity.actor}</span></div></div>)}{!timeline.length && <p className="empty-copy">暂无动态</p>}</div></div>}

              {tab === "advanced" && <div className="profile-sections advanced-sections">
                <section className="detail-section sensitive-section"><div className="sensitive-section-heading"><span><ShieldAlert size={18} /></span><div><h4>高级与敏感信息</h4><p>仅在明确进入本区域并主动加载后显示。列表、搜索和 AI 助手默认不可见。</p></div></div>{!sensitiveLoaded ? <button className="button sensitive-reveal-button" type="button" onClick={onRevealSensitive} disabled={sensitiveBusy || !onRevealSensitive}><Eye size={15} />{sensitiveBusy ? "正在安全加载..." : "加载完整敏感资料"}</button> : <div className="sensitive-loaded-state"><LockKeyhole size={15} /><span>敏感资料已在当前详情会话中加载</span></div>}</section>
                <section className="detail-section"><h4>数据血缘</h4><dl className="lineage-list"><div><dt>来源系统</dt><dd>{candidate.source_system || "-"}</dd></div><div><dt>源记录 ID</dt><dd>{sensitiveLoaded ? candidate.source_record_id || "-" : "已保护"}</dd></div><div><dt>导入批次</dt><dd>{candidate.import_batch_id || "手工录入"}</dd></div><div><dt>创建日期</dt><dd>{formatDate(candidate.created_at)}</dd></div><div><dt>简历更新</dt><dd>{formatDate(candidate.resume_updated_at)}</dd></div></dl></section>
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
  return <section className="detail-section"><div className="detail-section-heading"><h4 className="advanced-section-title">{icon}{title}</h4><span>{records.length} 条</span></div>{records.length ? <div className="advanced-record-list">{records.map((source, index) => { const record = source as Record<string, unknown>; const label = record.title ?? record.position_title ?? record.agreement_name ?? record.record_type ?? record.source_name ?? record.consent_type ?? record.source_application_id ?? record.application_id ?? record.source_record_id ?? `${title} ${index + 1}`; return <details key={String(record.id ?? index)}><summary>{valueText(label)}</summary><MetadataList record={record} />{sensitiveLoaded && <RawPayload payload={record.raw_payload as Record<string, unknown> | null | undefined} />}</details>; })}</div> : <p className="empty-copy">暂无记录</p>}</section>;
}
