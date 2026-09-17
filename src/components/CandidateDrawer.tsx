import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Archive,
  BookOpen,
  BriefcaseBusiness,
  Building2,
  ChevronRight,
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
  Sparkles,
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
import { candidateDisplayAge, candidateHireStatusText, formatDate, formatDateTime, hasHireInformation } from "../utils";
import {
  displayApplicantNumber,
  displayScalarValue,
  filterPlaceholderData,
  filterPlaceholderLines,
  hasVisibleProfileSection,
  isDisplayableValue,
  isInternalMetadataKey,
  visibleProfileSection,
} from "../profile-section-display";
import { TwAvatar } from "../views/TwAvatar";
import { CandidateAttachmentsPanel } from "./AttachmentWorkflow";
import { CandidateForm } from "./CandidateForm";

export type DrawerMode = "detail" | "create" | "edit" | null;
export type DetailTab = "profile" | "resume" | "assessment" | "activity" | "advanced";

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
  initialTab?: DetailTab;
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
const RESUME_GROUPS: Array<{ id: string; label: string; icon: typeof BriefcaseBusiness; types: string[]; timeline: boolean }> = [
  { id: "experience", label: "工作经历", icon: BriefcaseBusiness, types: ["experience", "work_experience", "internship", "management"], timeline: true },
  { id: "education", label: "教育经历", icon: GraduationCap, types: ["education", "campus", "training"], timeline: false },
  { id: "project", label: "项目经历", icon: FolderKanban, types: ["project", "publication", "award"], timeline: false },
  { id: "skill", label: "专业技能", icon: Sparkles, types: ["skill", "language", "certificate"], timeline: false },
  { id: "other", label: "其他资料", icon: BookOpen, types: ["other"], timeline: false },
];

const RESUME_RANGE_SEPARATORS = new Set(["-", "—", "–", "~", "～", "至"]);
const RESUME_DATE_CHARS = new Set("0123456789.年月日/");
const RESUME_NOW_WORDS = ["至今", "现在", "目前", "今"];

function splitResumeRange(content: string) {
  const source = content.trim();
  const head = source.slice(0, 4);
  const startsWithYear = head.length === 4 && head.split("").every((char) => char >= "0" && char <= "9");
  if (!startsWithYear) return { time: "", body: source };
  let index = 4;
  while (index < source.length && RESUME_DATE_CHARS.has(source[index])) index += 1;
  let cursor = index;
  while (cursor < source.length && source[cursor] === " ") cursor += 1;
  if (cursor >= source.length || !RESUME_RANGE_SEPARATORS.has(source[cursor])) return { time: "", body: source };
  cursor += 1;
  while (cursor < source.length && (source[cursor] === " " || RESUME_RANGE_SEPARATORS.has(source[cursor]))) cursor += 1;
  const rest = source.slice(cursor);
  const nowWord = RESUME_NOW_WORDS.find((word) => rest.startsWith(word));
  let tail = cursor;
  if (nowWord) tail = cursor + nowWord.length;
  else while (tail < source.length && RESUME_DATE_CHARS.has(source[tail])) tail += 1;
  if (tail === cursor) return { time: "", body: source };
  return { time: source.slice(0, tail).trim(), body: source.slice(tail).trim() };
}

function splitResumeTitle(title: string) {
  const parts = title.split("|").join("·").split("/").join("·").split("·").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return { heading: "", subheading: "" };
  return { heading: parts[0], subheading: parts.slice(1).join(" · ") };
}

const SOURCE_SYSTEM_LABELS: Record<string, string> = {
  beisen: "北森",
  manual: "手工录入",
  import: "数据导入",
};

function sourceLabelOf(value: unknown) {
  const key = String(value ?? "").trim();
  if (!key) return "";
  return SOURCE_SYSTEM_LABELS[key] ?? key;
}

function assessmentTypeLabel(value: unknown) {
  const key = String(value ?? "").trim();
  const labels: Record<string, string> = { professional: "专业能力评估", interview: "面谈记录", reference: "背景调查", exam: "笔试结果" };
  return labels[key] ?? key;
}

function assessmentStatusLabel(value: unknown) {
  const key = String(value ?? "").trim();
  const labels: Record<string, string> = { completed: "已完成", finished: "已完成", pending: "进行中", in_progress: "进行中", failed: "未通过" };
  return labels[key] ?? key;
}

function resumeGroupsOf(sections: Array<ReturnType<typeof visibleProfileSection>>) {
  const known = new Set<string>();
  for (const group of RESUME_GROUPS) for (const type of group.types) known.add(type);
  return RESUME_GROUPS.map((group) => ({
    ...group,
    entries: sections
      .filter((section) => (group.id === "other" ? !known.has(section.section_type) : group.types.includes(section.section_type)))
      .map((section) => {
        const content = splitResumeRange(filterPlaceholderLines(section.content));
        const heading = splitResumeTitle(filterPlaceholderLines(section.title));
        const structured = section.displayStructuredData;
        return {
          id: section.id,
          heading: heading.heading || SECTION_LABELS[section.section_type] || "来源资料",
          subheading: heading.subheading,
          time: content.time,
          body: content.body,
          sensitivity: section.sensitivity === "high" ? "敏感" : "",
          structured: isDisplayableValue(structured) ? (Array.isArray(structured) ? { items: structured } : (structured as Record<string, unknown>)) : null,
          raw: section.raw_payload,
        };
      }),
  })).filter((group) => group.entries.length > 0);
}

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (Array.isArray(value)) return value.map(valueText).join("、");
  if (typeof value === "object")
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}：${valueText(item)}`)
      .join("；");
  return String(value);
}

function metadataRows(record: Record<string, unknown>, omitted: string[] = []) {
  const hidden = new Set(["raw_payload", "metadata", ...omitted]);
  return Object.entries(record)
    .map(([key, value]) => [key, filterPlaceholderData(value)] as const)
    .filter(([key, value]) => !hidden.has(key) && !isInternalMetadataKey(key) && isDisplayableValue(value));
}

function MetadataList({ record, omitted }: { record: Record<string, unknown>; omitted?: string[] }) {
  const rows = metadataRows(record, omitted);
  if (!rows.length) return <p className="tw-empty-inline">暂无可展示信息</p>;
  return (
    <dl className="tw-metadata-list">
      {rows.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{valueText(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function RawPayload({ payload }: { payload?: Record<string, unknown> | null }) {
  const visible = filterPlaceholderData(payload);
  if (!visible || Array.isArray(visible) || !isDisplayableValue(visible)) return null;
  return (
    <details className="tw-disclosure">
      <summary>查看来源原始字段</summary>
      <MetadataList record={visible as Record<string, unknown>} />
    </details>
  );
}

function AdvancedRecordSection({ title, records, sensitiveLoaded }: { title: string; records: object[]; sensitiveLoaded: boolean }) {
  return (
    <details className="tw-acc">
      <summary>
        <span>{title}</span>
        <span className="tw-acc-tail">
          {records.length > 0 && <span className="tw-more">{records.length} 条</span>}
          <ChevronRight size={16} />
        </span>
      </summary>
      <div className="tw-acc-body">
        {records.length ? (
          <div className="tw-details-list">
            {records.map((entry, index) => {
              const record = entry as Record<string, unknown>;
              const label =
                [
                  record.title,
                  record.position_title,
                  record.agreement_name,
                  record.record_type,
                  record.source_name,
                  record.consent_type,
                  sensitiveLoaded ? record.source_application_id : undefined,
                  sensitiveLoaded ? record.application_id : undefined,
                ]
                  .map(displayScalarValue)
                  .find(Boolean) ?? `${title} ${index + 1}`;
              return (
                <details key={String(record.id ?? index)}>
                  <summary>{displayScalarValue(label)}</summary>
                  <MetadataList record={record} omitted={sensitiveLoaded ? undefined : ["source_application_id", "application_id"]} />
                  {sensitiveLoaded && <RawPayload payload={record.raw_payload as Record<string, unknown> | null | undefined} />}
                </details>
              );
            })}
          </div>
        ) : (
          <p className="tw-empty-inline">暂无记录</p>
        )}
      </div>
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
  initialTab = "profile",
}: CandidateDrawerProps) {
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [noteText, setNoteText] = useState("");
  const [selectedPositionId, setSelectedPositionId] = useState("");
  const [selectedPoolId, setSelectedPoolId] = useState("");

  useEffect(() => {
    setTab(initialTab);
    setNoteText("");
    setSelectedPositionId("");
    setSelectedPoolId("");
  }, [candidate?.id, mode, initialTab]);

  const availablePositions = useMemo(() => {
    const linkedIds = new Set(candidate?.positions.map((position) => position.id) ?? []);
    return positions
      .filter((position) => !position.archived_at && !linkedIds.has(position.id))
      .sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
  }, [candidate?.positions, positions]);

  const availablePools = useMemo(() => {
    const linkedIds = new Set(candidate?.talent_pools.map((pool) => pool.id) ?? []);
    return talentPools
      .filter((pool) => !pool.archived_at && !linkedIds.has(pool.id))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }, [candidate?.talent_pools, talentPools]);

  const timeline = useMemo(() => {
    const notesById = new Map(notes.map((note) => [note.id, note]));
    const fieldLabels: Record<string, string> = {
      owner: "负责人",
      phone: "手机号",
      email: "邮箱",
      current_company: "最近公司",
      current_title: "最近职位",
      location: "所在地",
      tags: "标签",
      source: "有效来源",
      gender: "性别",
      birth_date: "出生日期",
      age: "年龄",
      highest_school: "最高学历学校",
      highest_major: "最高学历专业",
      job_seeking_status: "求职状态",
      hire_status: "入职状态",
      hire_date: "入职日期",
      hire_position: "入职职位",
    };
    return activities.map((activity) => {
      const noteId = typeof activity.metadata.note_id === "string" ? activity.metadata.note_id : "";
      const note = noteId ? notesById.get(noteId) : undefined;
      const fields = Array.isArray(activity.metadata.fields)
        ? activity.metadata.fields.filter((field): field is string => typeof field === "string")
        : [];
      const relatedName =
        [activity.metadata.position_title, activity.metadata.pool_name].find((value): value is string => typeof value === "string") ?? "";
      return {
        ...activity,
        detail: note?.content ?? (fields.length ? `变更字段：${fields.map((field) => fieldLabels[field] ?? field).join("、")}` : relatedName),
        actor: note?.author ?? "本地用户",
        tone:
          activity.type === "note_added"
            ? "note"
            : activity.type.includes("archived")
              ? "archived"
              : activity.type.includes("restored")
                ? "restored"
                : activity.type.includes("created") || activity.type.includes("imported")
                  ? "created"
                  : "updated",
      };
    });
  }, [activities, notes]);

  useEffect(() => {
    if (!mode) {
      document.body.classList.remove("tw-drawer-inline");
      return;
    }
    document.body.classList.add("tw-drawer-inline");
    return () => document.body.classList.remove("tw-drawer-inline");
  }, [mode]);
  if (!mode) return null;
  const title = mode === "create" ? "新建候选人" : mode === "edit" ? "编辑候选人" : "候选人详情";

  function submitNote() {
    const content = noteText.trim();
    if (!content) return;
    onAddNote(content);
    setNoteText("");
  }
  const sections = (candidate?.profile_sections ?? []).filter(hasVisibleProfileSection).map(visibleProfileSection);
  const resumeGroups = resumeGroupsOf(sections);
  const assessments = candidate?.assessments ?? [];
  const preferences = candidate?.preferences;
  const age = candidate ? candidateDisplayAge(candidate) : null;
  const sourceRecordId = candidate?.source_system === "manual" ? "" : candidate?.source_record_id ?? "";
  const applicantNumber = displayApplicantNumber(candidate?.source_system, sourceRecordId);
  const phone = sensitiveLoaded ? displayScalarValue(candidate?.phone) : "显式查看后显示";
  const email = sensitiveLoaded ? displayScalarValue(candidate?.email) : "显式查看后显示";
  const location = displayScalarValue(candidate?.location);
  const gender = displayScalarValue(candidate?.gender);
  const ageText = age === null ? "" : `${age} 岁`;
  const currentCompany = displayScalarValue(candidate?.current_company);
  const currentTitle = displayScalarValue(candidate?.current_title);
  const yearsExperience =
    candidate?.years_experience_display ||
    candidate?.years_experience_raw ||
    (candidate?.years_experience !== null && candidate?.years_experience !== undefined ? `${candidate.years_experience} 年` : "");
  const education = displayScalarValue(candidate?.education);
  const highestSchool = displayScalarValue(candidate?.highest_school);
  const highestMajor = displayScalarValue(candidate?.highest_major);
  const selfSummary = displayScalarValue(candidate?.self_summary);
  const jobSeekingStatus = displayScalarValue(candidate?.job_seeking_status) || displayScalarValue(preferences?.employment_status);
  const hireStatus = candidateHireStatusText(candidate?.hire_status);
  const hireDateText = candidate?.hire_date ? formatDate(candidate.hire_date) : "";
  const hirePosition = displayScalarValue(candidate?.hire_position);
  const desiredTitles = displayScalarValue(preferences?.desired_titles);
  const desiredLocations = displayScalarValue(preferences?.desired_locations);
  const employmentType = displayScalarValue(preferences?.employment_type);
  const expectedSalary = sensitiveLoaded
    ? displayScalarValue(preferences?.expected_salary) || displayScalarValue(candidate?.expected_salary)
    : "敏感信息";
  const availability = displayScalarValue(preferences?.availability);
  const hasContact = Boolean(phone || email || location);
  const hasDemographics = Boolean(gender || ageText || applicantNumber);
  const lineageRows = [
    { label: "来源系统", value: displayScalarValue(candidate?.source_system) },
    { label: "源记录 ID", value: applicantNumber && sensitiveLoaded ? applicantNumber : applicantNumber ? "已保护" : "" },
    { label: "导入批次", value: displayScalarValue(candidate?.import_batch_id) || (candidate?.source_system === "manual" ? "手工录入" : "") },
    { label: "创建日期", value: candidate?.created_at ? formatDate(candidate.created_at) : "" },
    { label: "简历更新", value: candidate?.resume_updated_at ? formatDate(candidate.resume_updated_at) : "" },
  ].filter((row) => isDisplayableValue(row.value));


  return (
    <div className="tw-drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <aside
        className={`tw-drawer${mode === "detail" ? "" : " tw-drawer-wide"}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={busy || undefined}
      >
        {mode !== "detail" && (
          <header className="tw-drawer-head">
            <div className="tw-drawer-headline">
              <h2>{title}</h2>
            </div>
            <button className="tw-icon-plain" type="button" onClick={onClose} disabled={busy} aria-label="关闭" title="关闭">
              <X size={19} />
            </button>
          </header>
        )}
        {mode === "create" && (
          <CandidateForm
            submitLabel={pendingProfileSave ? "重试保存偏好与履历" : "创建档案"}
            statusMessage={pendingProfileSave ? "候选人已创建，偏好或履历未完整保存。请重试，系统不会重复创建候选人。" : undefined}
            fieldsDisabled={pendingProfileSave}
            busy={busy}
            onCancel={onClose}
            onSubmit={onSave}
          />
        )}
        {mode === "edit" && candidate && (
          <CandidateForm initialValue={candidate} submitLabel="保存修改" busy={busy} onCancel={onClose} onSubmit={onSave} />
        )}
        {mode === "detail" && candidate && (
          <Fragment>
            <div className="tw-drawer-identity">
              <TwAvatar candidate={candidate} size={84} />
              <div className="tw-identity-main">
                <div className="tw-identity-name">
                  <h2>{displayScalarValue(candidate.name) || "未命名候选人"}</h2>
                  {jobSeekingStatus && (
                    <span className="tw-status tw-status-active">
                      <span className="tw-dot" style={{ backgroundColor: "currentColor" }} />
                      {jobSeekingStatus}
                    </span>
                  )}
                  {candidate.archived_at && <span className="tw-status tw-status-archived">已归档</span>}
                </div>
                <p className="tw-identity-role">{currentTitle || "最近职位待补充"}</p>
                {currentCompany && <p className="tw-identity-company">{currentCompany}</p>}
                {(location || yearsExperience || education) && (
                  <div className="tw-identity-facts">
                    {location && (
                      <span>
                        <MapPin size={14} />
                        {location}
                      </span>
                    )}
                    {yearsExperience && (
                      <span>
                        <BriefcaseBusiness size={14} />
                        {yearsExperience}
                      </span>
                    )}
                    {education && (
                      <span>
                        <GraduationCap size={14} />
                        {[education, highestSchool].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
            <button className="tw-drawer-close tw-icon-plain" type="button" onClick={onClose} disabled={busy} aria-label="关闭详情" title="关闭">
              <X size={19} />
            </button>
            <div className="tw-drawer-tabs" role="tablist" aria-label="候选人信息">
              <button className={tab === "profile" ? "active" : ""} type="button" role="tab" aria-selected={tab === "profile"} onClick={() => setTab("profile")}>
                档案
              </button>
              <button className={tab === "resume" ? "active" : ""} type="button" role="tab" aria-selected={tab === "resume"} onClick={() => setTab("resume")}>
                履历
              </button>
              <button className={tab === "assessment" ? "active" : ""} type="button" role="tab" aria-selected={tab === "assessment"} onClick={() => setTab("assessment")}>
                历史评估
              </button>
              <button className={tab === "activity" ? "active" : ""} type="button" role="tab" aria-selected={tab === "activity"} onClick={() => setTab("activity")}>
                备注与动态
              </button>
              <button className={tab === "advanced" ? "active" : ""} type="button" role="tab" aria-selected={tab === "advanced"} onClick={() => setTab("advanced")}>
                高级信息
              </button>
            </div>            <div className="tw-drawer-body">
              {tab === "profile" && (
                <div className="tw-drawer-sections">
                  {(hasContact || hasDemographics || (!sensitiveLoaded && onRevealSensitive)) && (
                    <section className="tw-section">
                      <h3 className="tw-section-title">基本资料与联系方式</h3>
                      <dl className="tw-rows tw-rows-1">
                        <div className="tw-row">
                          <dt className="tw-row-label">姓名</dt>
                          <dd className="tw-row-value">{displayScalarValue(candidate.name) || "未命名候选人"}</dd>
                        </div>
                        {phone && (
                          <div className="tw-row">
                            <dt className="tw-row-label">手机</dt>
                            <dd className="tw-row-value tw-row-inline">
                              <span className="tw-row-text">{phone}</span>
                              {!sensitiveLoaded && onRevealSensitive && (
                                <button className="tw-btn tw-btn-sm tw-reveal-btn" type="button" onClick={onRevealSensitive} disabled={sensitiveBusy}>
                                  显示
                                </button>
                              )}
                            </dd>
                          </div>
                        )}
                        {email && (
                          <div className="tw-row">
                            <dt className="tw-row-label">邮箱</dt>
                            <dd className="tw-row-value tw-row-inline">
                              <span className="tw-row-text">{email}</span>
                              {!sensitiveLoaded && onRevealSensitive && (
                                <button className="tw-btn tw-btn-sm tw-reveal-btn" type="button" onClick={onRevealSensitive} disabled={sensitiveBusy}>
                                  显示
                                </button>
                              )}
                            </dd>
                          </div>
                        )}
                        {location && (
                          <div className="tw-row">
                            <dt className="tw-row-label">所在城市</dt>
                            <dd className="tw-row-value">{location}</dd>
                          </div>
                        )}
                        {gender && (
                          <div className="tw-row">
                            <dt className="tw-row-label">性别</dt>
                            <dd className="tw-row-value">{gender}</dd>
                          </div>
                        )}
                        {ageText && (
                          <div className="tw-row">
                            <dt className="tw-row-label">年龄</dt>
                            <dd className="tw-row-value">{ageText}</dd>
                          </div>
                        )}
                        {sourceRecordId && applicantNumber && (
                          <div className="tw-row">
                            <dt className="tw-row-label">应聘者编号</dt>
                            <dd className="tw-row-value">{applicantNumber}</dd>
                          </div>
                        )}
                      </dl>
                    </section>
                  )}
                  {(currentCompany || currentTitle || yearsExperience || education || highestSchool || highestMajor || selfSummary) && (
                    <section className="tw-section">
                      <h3 className="tw-section-title">最近经历与教育摘要</h3>
                      <dl className="tw-rows tw-rows-1">
                        {currentTitle && (
                          <div className="tw-row">
                            <dt className="tw-row-label">最近职位</dt>
                            <dd className="tw-row-value">{currentTitle}</dd>
                          </div>
                        )}
                        {currentCompany && (
                          <div className="tw-row">
                            <dt className="tw-row-label">最近公司</dt>
                            <dd className="tw-row-value">{currentCompany}</dd>
                          </div>
                        )}
                        {location && (
                          <div className="tw-row">
                            <dt className="tw-row-label">工作城市</dt>
                            <dd className="tw-row-value">{location}</dd>
                          </div>
                        )}
                        {education && (
                          <div className="tw-row">
                            <dt className="tw-row-label">学历</dt>
                            <dd className="tw-row-value">{education}</dd>
                          </div>
                        )}
                        {highestSchool && (
                          <div className="tw-row">
                            <dt className="tw-row-label">毕业院校</dt>
                            <dd className="tw-row-value">{highestSchool}</dd>
                          </div>
                        )}
                        {highestMajor && (
                          <div className="tw-row">
                            <dt className="tw-row-label">专业</dt>
                            <dd className="tw-row-value">{highestMajor}</dd>
                          </div>
                        )}
                        {yearsExperience && (
                          <div className="tw-row">
                            <dt className="tw-row-label">工作经验</dt>
                            <dd className="tw-row-value">{yearsExperience}</dd>
                          </div>
                        )}
                      </dl>
                      {selfSummary && (
                        <div className="tw-row tw-row-block" style={{ marginTop: 10 }}>
                          <span className="tw-row-label">自我评价</span>
                          <p className="tw-note">{selfSummary}</p>
                        </div>
                      )}
                    </section>
                  )}
                  {(jobSeekingStatus || desiredTitles || desiredLocations || employmentType || expectedSalary || availability) && (
                    <section className="tw-section">
                      <h3 className="tw-section-title">求职偏好</h3>
                      <dl className="tw-rows tw-rows-1">
                        {desiredTitles && (
                          <div className="tw-row">
                            <dt className="tw-row-label">期望职位</dt>
                            <dd className="tw-row-value">{desiredTitles}</dd>
                          </div>
                        )}
                        {desiredLocations && (
                          <div className="tw-row">
                            <dt className="tw-row-label">期望城市</dt>
                            <dd className="tw-row-value">{desiredLocations}</dd>
                          </div>
                        )}
                        {employmentType && (
                          <div className="tw-row">
                            <dt className="tw-row-label">工作性质</dt>
                            <dd className="tw-row-value">{employmentType}</dd>
                          </div>
                        )}
                        {expectedSalary && (
                          <div className="tw-row">
                            <dt className="tw-row-label">期望薪资</dt>
                            <dd className="tw-row-value">{expectedSalary}</dd>
                          </div>
                        )}
                        {availability && (
                          <div className="tw-row">
                            <dt className="tw-row-label">到岗时间</dt>
                            <dd className="tw-row-value">{availability}</dd>
                          </div>
                        )}
                        {jobSeekingStatus && (
                          <div className="tw-row">
                            <dt className="tw-row-label">求职状态</dt>
                            <dd className="tw-row-value">{jobSeekingStatus}</dd>
                          </div>
                        )}
                      </dl>
                    </section>
                  )}
                  {hasHireInformation(candidate) && (
                    <section className="tw-section">
                      <h3 className="tw-section-title">入职信息</h3>
                      <dl className="tw-rows tw-rows-1">
                        {hireStatus && (
                          <div className="tw-row">
                            <dt className="tw-row-label">入职状态</dt>
                            <dd className="tw-row-value">{hireStatus}</dd>
                          </div>
                        )}
                        {hireDateText && (
                          <div className="tw-row">
                            <dt className="tw-row-label">入职日期</dt>
                            <dd className="tw-row-value">{hireDateText}</dd>
                          </div>
                        )}
                        {hirePosition && (
                          <div className="tw-row">
                            <dt className="tw-row-label">入职职位</dt>
                            <dd className="tw-row-value">{hirePosition}</dd>
                          </div>
                        )}
                      </dl>
                    </section>
                  )}                  <section className="tw-section">
                    <div className="tw-section-head">
                      <h3 className="tw-section-title">关联职位</h3>
                      <span className="tw-more">{candidate.positions.length} 个</span>
                    </div>
                    {candidate.positions.length ? (
                      <div className="tw-linked-list">
                        {candidate.positions.map((position) => (
                          <div className={`tw-linked-row${position.archived_at ? " is-archived" : ""}`} key={position.id}>
                            <span className="tw-object-icon" style={{ width: 34, height: 34 }}>
                              <BriefcaseBusiness size={16} />
                            </span>
                            <span className="tw-stack">
                              <strong>{position.title}</strong>
                              <small className="tw-meta">{[position.department, position.location].filter(Boolean).join(" · ") || "部门与地点未设置"}</small>
                            </span>
                            <span className={`tw-badge tw-badge-${position.archived_at ? "archived" : position.status}`}>
                              {position.archived_at ? "已归档" : POSITION_STATUS_LABELS[position.status]}
                            </span>
                            <span className="tw-row-actions">
                              {onOpenPosition && (
                                <button className="tw-icon-plain" type="button" onClick={() => onOpenPosition(position)} aria-label={`打开职位 ${position.title}`} title="打开职位详情">
                                  <ExternalLink size={15} />
                                </button>
                              )}
                              {!candidate.archived_at && onUnlinkPosition && (
                                <button
                                  className="tw-icon-plain"
                                  type="button"
                                  onClick={() => onUnlinkPosition(position.id)}
                                  disabled={positionBusy}
                                  aria-label={`解除与职位 ${position.title} 的关联`}
                                  title="解除关联"
                                >
                                  <Unlink size={15} />
                                </button>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="tw-empty-inline">尚未关联招聘职位</p>
                    )}
                    {!candidate.archived_at && onLinkPosition && availablePositions.length > 0 && (
                      <div className="tw-link-control">
                        <label>
                          <span className="sr-only">选择职位</span>
                          <select value={selectedPositionId} onChange={(event) => setSelectedPositionId(event.target.value)} disabled={positionBusy}>
                            <option value="">选择已有职位</option>
                            {availablePositions.map((position) => (
                              <option value={position.id} key={position.id}>
                                {position.title} · {POSITION_STATUS_LABELS[position.status]}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button className="tw-btn tw-btn-sm" type="button" onClick={() => selectedPositionId && onLinkPosition(selectedPositionId)} disabled={positionBusy || !selectedPositionId}>
                          <Link2 size={15} />
                          关联职位
                        </button>
                      </div>
                    )}
                  </section>
                  <section className="tw-section">
                    <div className="tw-section-head">
                      <h3 className="tw-section-title">人才库与来源</h3>
                      <span className="tw-more">{candidate.talent_pools.length} 个分组</span>
                    </div>
                    {candidate.talent_pools.length ? (
                      <div className="tw-linked-list">
                        {candidate.talent_pools.map((pool) => (
                          <div className="tw-linked-row" key={pool.id}>
                            <span className="tw-dot" style={{ backgroundColor: pool.color }} />
                            <span className="tw-stack">
                              <strong>{pool.name}</strong>
                              <small className="tw-meta">{pool.description || "人才库分组"}</small>
                            </span>
                            {!candidate.archived_at && onUnlinkTalentPool && (
                              <button className="tw-icon-plain" type="button" onClick={() => onUnlinkTalentPool(pool.id)} disabled={busy} aria-label={`从 ${pool.name} 移出`} title="移出人才库">
                                <Unlink size={15} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="tw-empty-inline">尚未加入人才库</p>
                    )}
                    {!candidate.archived_at && onLinkTalentPool && availablePools.length > 0 && (
                      <div className="tw-link-control">
                        <label>
                          <span className="sr-only">选择人才库</span>
                          <select value={selectedPoolId} onChange={(event) => setSelectedPoolId(event.target.value)} disabled={busy}>
                            <option value="">选择人才库</option>
                            {availablePools.map((pool) => (
                              <option value={pool.id} key={pool.id}>
                                {pool.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button className="tw-btn tw-btn-sm" type="button" onClick={() => selectedPoolId && onLinkTalentPool(selectedPoolId)} disabled={busy || !selectedPoolId}>
                          <FolderKanban size={15} />
                          加入人才库
                        </button>
                      </div>
                    )}
                    <dl className="tw-rows tw-rows-1" style={{ marginTop: 6 }}>
                      <div className="tw-row">
                        <dt className="tw-row-label">来源</dt>
                        <dd className="tw-row-value">{candidate.source || "未填写"}</dd>
                      </div>
                      <div className="tw-row">
                        <dt className="tw-row-label">人才负责人</dt>
                        <dd className="tw-row-value">{candidate.owner || "未分配"}</dd>
                      </div>
                    </dl>
                  </section>
                </div>
              )}              {tab === "resume" && (
                <div className="tw-drawer-sections tw-resume-view">
                  {resumeGroups.map((group) => (
                    <section className="tw-resume-group" key={group.id}>
                      <div className="tw-resume-group-head">
                        <group.icon size={19} />
                        <h4>{group.label}</h4>
                      </div>
                      <div className={group.timeline ? "tw-resume-entries is-timeline" : "tw-resume-entries"}>
                        {group.entries.map((entry) => (
                          <article className="tw-resume-entry" key={entry.id}>
                            <div className="tw-resume-entry-head">
                              <strong>{entry.heading}</strong>
                              {entry.sensitivity && <span className="tw-scope-chip">{entry.sensitivity}</span>}
                              {entry.time && <time>{entry.time}</time>}
                            </div>
                            {entry.subheading && <p className="tw-resume-entry-sub">{entry.subheading}</p>}
                            {entry.body && <p className="tw-resume-entry-body">{entry.body}</p>}
                            {entry.structured && (
                              <details className="tw-resume-entry-more">
                                <summary>查看结构化字段</summary>
                                <MetadataList record={entry.structured} />
                              </details>
                            )}
                            <RawPayload payload={entry.raw} />
                          </article>
                        ))}
                      </div>
                    </section>
                  ))}
                  {!resumeGroups.length && (
                    <div className="tw-empty-sm">
                      <FileText size={22} />
                      <span>暂无履历资料</span>
                    </div>
                  )}
                  <CandidateAttachmentsPanel candidate={candidate} disabled={!!candidate.archived_at} onCandidateUpdated={onCandidateUpdated} onCandidateCreated={onCandidateCreated} />
                </div>
              )}
              {tab === "assessment" && (
                <div className="tw-drawer-sections">
                  <section className="tw-section">
                    <div className="tw-section-head">
                      <h4 className="tw-section-title">历史评估资料</h4>
                      <span className="tw-more">{assessments.length} 条来源记录</span>
                    </div>
                    <p className="tw-hint">历史评估仅作为人才档案资料展示，不代表当前招聘流程状态。</p>
                    {assessments.length ? (
                      <div className="tw-assess-list">
                        {assessments.map((record) => (
                          <article className="tw-assess" key={record.id}>
                            <header className="tw-assess-head">
                              <strong>{record.title || record.assessment_type || "历史评估"}</strong>
                              <span className="tw-assess-meta">
                                <time>{formatDate(record.occurred_at || record.assessed_at || record.created_at || null)}</time>
                                {sourceLabelOf(record.source_system) && <small>来源：{sourceLabelOf(record.source_system)}</small>}
                              </span>
                            </header>
                            <p className="tw-assess-body">
                              {displayScalarValue(record.conclusion) || displayScalarValue(record.summary) || displayScalarValue(record.result) || displayScalarValue(record.status) || "结果未标注"}
                            </p>
                            <details className="tw-assess-more">
                              <summary>查看来源字段</summary>
                              <MetadataList
                                record={{
                                  评估类型: assessmentTypeLabel(record.assessment_type),
                                  评估状态: assessmentStatusLabel(record.status),
                                  评分: record.score,
                                  发生日期: record.occurred_at || record.assessed_at,
                                  来源系统: sourceLabelOf(record.source_system),
                                  来源记录: sensitiveLoaded ? record.source_record_id : "",
                                }}
                              />
                            </details>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="tw-empty-sm">
                        <History size={22} />
                        <span>暂无历史评估资料</span>
                      </div>
                    )}
                  </section>
                </div>
              )}
              {tab === "activity" && (
                <div className="tw-activity">
                  {!candidate.archived_at && (
                    <section className="tw-note-section">
                      <h3 className="tw-section-title">添加跟进备注</h3>
                      <div className="tw-note-composer">
                        <textarea
                          value={noteText}
                          onChange={(event) => setNoteText(event.target.value)}
                          placeholder="记录候选人的最新沟通与跟进信息"
                          rows={4}
                          disabled={busy}
                        />
                        <button className="tw-btn tw-btn-primary" type="button" onClick={submitNote} disabled={busy || !noteText.trim()}>
                          保存备注
                        </button>
                      </div>
                    </section>
                  )}
                  <section className="tw-section">
                    <h3 className="tw-section-title">动态记录</h3>
                    <div className="tw-timeline">
                      {timeline.map((entry) => (
                        <div className="tw-timeline-item" key={entry.id}>
                          <span className={`tw-timeline-dot is-${entry.tone}`}>
                            {entry.tone === "note" ? <MessageSquareText size={15} /> : <Clock3 size={15} />}
                          </span>
                          <div className="tw-timeline-main">
                            <div className="tw-timeline-head">
                              <time>{formatDateTime(entry.created_at)}</time>
                              <span className="tw-timeline-tag">{entry.tone === "note" ? "手动备注" : "系统活动"}</span>
                            </div>
                            <strong className="tw-timeline-title">{entry.description}</strong>
                            {entry.detail && <p className="tw-timeline-body">{entry.detail}</p>}
                          </div>
                        </div>
                      ))}
                      {!timeline.length && <p className="tw-empty-inline">暂无动态</p>}
                    </div>
                  </section>
                </div>
              )}
              {tab === "advanced" && (
                <div className="tw-drawer-sections">
                  <section className="tw-section tw-sensitive">
                    <span className="tw-sensitive-icon">
                      <ShieldAlert size={22} />
                    </span>
                    <h3 className="tw-sensitive-title">高级与敏感信息</h3>
                    {sensitiveLoaded ? (
                      <div className="tw-sensitive-loaded">
                        <LockKeyhole size={15} />
                        <span>敏感资料已在当前详情会话中加载</span>
                      </div>
                    ) : (
                      <Fragment>
                        <button className="tw-btn tw-btn-primary" type="button" onClick={onRevealSensitive} disabled={sensitiveBusy || !onRevealSensitive}>
                          <Eye size={15} />
                          {sensitiveBusy ? "正在安全加载..." : "加载完整敏感资料"}
                        </button>
                        <p className="tw-hint">主动加载后显示完整资料。列表、搜索与 AI 助手默认不可见。</p>
                      </Fragment>
                    )}
                  </section>
                  <section className="tw-section">
                    <h4 className="tw-section-title">数据血缘</h4>
                    <dl className="tw-rows tw-rows-1">
                      {lineageRows.map((row) => (
                        <div className="tw-row" key={row.label}>
                          <dt>{row.label}</dt>
                          <dd>{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                  <AdvancedRecordSection title="来源记录" records={candidate.source_records ?? []} sensitiveLoaded={sensitiveLoaded} />
                  <AdvancedRecordSection title="职位申请来源" records={candidate.position_sources ?? []} sensitiveLoaded={sensitiveLoaded} />
                  <AdvancedRecordSection title="授权与隐私记录" records={candidate.consents ?? []} sensitiveLoaded={sensitiveLoaded} />
                </div>
              )}
            </div>
            <footer className="tw-drawer-foot">
              {candidate.archived_at ? (
                <Fragment>
                  <button className="tw-btn tw-btn-quiet-danger" type="button" onClick={onDelete} disabled={busy}>永久删除</button>
                  <span className="tw-spacer" />
                  <button className="tw-btn tw-btn-primary tw-drawer-foot-wide" type="button" onClick={onRestore} disabled={busy}>恢复候选人</button>
                </Fragment>
              ) : (
                <Fragment>
                  <button className="tw-btn tw-drawer-foot-wide" type="button" onClick={onEdit} disabled={busy}>编辑资料</button>
                  <button className="tw-btn tw-btn-primary tw-drawer-foot-wide" type="button" onClick={onArchive} disabled={busy}>归档</button>
                </Fragment>
              )}
            </footer>
          </Fragment>
        )}
      </aside>
    </div>
  );
}
