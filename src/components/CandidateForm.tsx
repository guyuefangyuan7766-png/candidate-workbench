import { FormEvent, useEffect, useRef, useState } from "react";
import { ImageIcon, Plus, Save, Trash2, X } from "lucide-react";
import { EDUCATION_OPTIONS, emptyDraft, OWNERS, SOURCES, type Candidate, type CandidateDraft, type CandidateProfileSectionDraft } from "../types";
import { filterPlaceholderData, filterPlaceholderLines, isDisplayableValue, profileSectionTitleAfterTypeChange } from "../profile-section-display";

interface AttachmentAvatarOption { available: boolean; source?: "explicit_url" | "docx_embedded_image" | "pdf_embedded_image" | "xlsx_embedded_image" | null; confidence?: "high" | "medium" | "low" | null; width?: number; height?: number; }
export interface CandidateFormSubmitOptions { includeAttachmentAvatar: boolean; }
interface CandidateFormProps { initialValue?: Candidate; initialDraft?: Partial<CandidateDraft>; attachmentAvatar?: AttachmentAvatarOption; submitLabel: string; busy?: boolean; fieldsDisabled?: boolean; requireContact?: boolean; statusMessage?: string; onCancel: () => void; onSubmit: (draft: CandidateDraft, options: CandidateFormSubmitOptions) => void; }

const PROFILE_SECTION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "education", label: "教育经历" }, { value: "experience", label: "工作经历" },
  { value: "project", label: "项目经历" }, { value: "internship", label: "实习经历" },
  { value: "skill", label: "技能" }, { value: "language", label: "语言能力" },
  { value: "certificate", label: "证书" }, { value: "campus", label: "校园经历" },
  { value: "award", label: "奖励与荣誉" }, { value: "training", label: "培训经历" },
  { value: "publication", label: "论文与作品" }, { value: "management", label: "管理经历" },
  { value: "other", label: "附加信息" },
];
const PROFILE_SECTION_LABELS = Object.fromEntries(PROFILE_SECTION_OPTIONS.map((option) => [option.value, option.label]));
const PROFILE_SECTION_TYPE_ALIASES: Record<string, string> = { education_experience: "education", work_experience: "experience", project_experience: "project", skills: "skill", additional: "other", additional_information: "other" };
const LEGACY_SUMMARY_TYPES = new Set(["self_summary", "resume_summary"]);
type FormSectionKey = "basic" | "career" | "preference" | "resume";
const FORM_SECTION_KEYS: FormSectionKey[] = ["basic", "career", "preference", "resume"];
const FORM_SECTIONS: Array<{ key: FormSectionKey; label: string }> = [
  { key: "basic", label: "基本信息" },
  { key: "career", label: "职业与教育" },
  { key: "preference", label: "求职偏好" },
  { key: "resume", label: "履历资料" },
];
type EditableProfileSectionInput = Omit<Partial<CandidateProfileSectionDraft>, "sensitivity"> & { sensitivity?: string | null };
function rawSectionType(value: unknown) { return String(value ?? "").trim().toLowerCase(); }
function isLegacySummarySection(section: Pick<EditableProfileSectionInput, "section_type" | "structured_data">) { const type = rawSectionType(section.section_type); if (LEGACY_SUMMARY_TYPES.has(type)) return true; const structured = section.structured_data; return Boolean(structured && !Array.isArray(structured) && rawSectionType((structured as Record<string, unknown>).semantic_type) === "self_summary"); }
export function canonicalProfileSectionType(value: unknown) { const raw = rawSectionType(value); return PROFILE_SECTION_TYPE_ALIASES[raw] ?? (PROFILE_SECTION_LABELS[raw] ? raw : "other"); }
function sectionDraftFrom(section: EditableProfileSectionInput): CandidateProfileSectionDraft { const type = canonicalProfileSectionType(section.section_type); return { id: typeof section.id === "string" && section.id.trim() ? section.id : undefined, section_type: type, title: typeof section.title === "string" && section.title.trim() ? section.title : PROFILE_SECTION_LABELS[type] ?? "", content: typeof section.content === "string" ? section.content : "", structured_data: section.structured_data ?? null, sort_order: Number.isFinite(Number(section.sort_order)) ? Number(section.sort_order) : 0, sensitivity: section.sensitivity === "public" || section.sensitivity === "high" ? section.sensitivity : "internal", source_record_id: section.source_record_id ?? null }; }
function hasSectionValue(section: CandidateProfileSectionDraft) {
  return Boolean(filterPlaceholderLines(section.content) || isDisplayableValue(filterPlaceholderData(section.structured_data)));
}
function shouldPersistProfileSection(section: CandidateProfileSectionDraft) {
  const existingSectionId = typeof section.id === "string" ? section.id.trim() : "";
  return Boolean(existingSectionId) || hasSectionValue(section);
}
export function normalizeEditableProfileSections(sections: EditableProfileSectionInput[] | undefined): CandidateProfileSectionDraft[] | undefined { if (sections === undefined) return undefined; return sections.filter((section) => !isLegacySummarySection(section)).map((section, index) => sectionDraftFrom({ ...section, sort_order: index })).filter(shouldPersistProfileSection); }
function profileSectionTypePatch(section: CandidateProfileSectionDraft, nextTypeValue: unknown) { const currentType = canonicalProfileSectionType(section.section_type); const nextType = canonicalProfileSectionType(nextTypeValue); return { section_type: nextType, title: profileSectionTitleAfterTypeChange(section.title, PROFILE_SECTION_LABELS[currentType], PROFILE_SECTION_LABELS[nextType]) }; }

function draftFrom(candidate?: Candidate, initialDraft?: Partial<CandidateDraft>): CandidateDraft {
  const base: CandidateDraft = candidate ? { name: candidate.name, phone: candidate.phone, email: candidate.email, gender: candidate.gender, birth_date: candidate.birth_date, age: candidate.age, current_company: candidate.current_company, current_title: candidate.current_title, location: candidate.location, years_experience: candidate.years_experience_raw || candidate.years_experience_display || "", education: candidate.education, highest_school: candidate.highest_school, highest_major: candidate.highest_major, job_seeking_status: candidate.job_seeking_status, hire_position: candidate.hire_position ?? "", hire_status: candidate.hire_status ?? "", hire_date: candidate.hire_date ?? null, resume_updated_at: candidate.resume_updated_at, self_summary: candidate.self_summary, source: candidate.source, stage: candidate.stage, owner: candidate.owner, tags: candidate.tags, expected_salary: candidate.expected_salary, preferences: { employment_status: candidate.preferences?.employment_status ?? "", desired_titles: candidate.preferences?.desired_titles ?? [], desired_locations: candidate.preferences?.desired_locations ?? [], employment_type: candidate.preferences?.employment_type ?? "", expected_salary: candidate.preferences?.expected_salary || candidate.expected_salary, availability: candidate.preferences?.availability ?? "" }, profile_sections: Array.isArray(candidate.profile_sections) ? normalizeEditableProfileSections(candidate.profile_sections) : undefined } : { ...emptyDraft, tags: [...emptyDraft.tags], preferences: { ...emptyDraft.preferences } };
  return { ...base, ...initialDraft, tags: [...(initialDraft?.tags ?? base.tags)], preferences: { ...base.preferences, ...(initialDraft?.preferences ?? {}) }, profile_sections: initialDraft?.profile_sections === undefined ? base.profile_sections : normalizeEditableProfileSections(initialDraft.profile_sections) };
}
function splitValues(value: string) { return value.split(/[,，、]/).map((item) => item.trim()).filter(Boolean).slice(0, 20); }
function defaultAttachmentAvatarSelection(attachmentAvatar?: AttachmentAvatarOption) { return Boolean(attachmentAvatar?.available && attachmentAvatar.source !== "explicit_url"); }

export function CandidateForm({ initialValue, initialDraft, attachmentAvatar, submitLabel, busy = false, fieldsDisabled = false, requireContact = true, statusMessage, onCancel, onSubmit }: CandidateFormProps) {
  const [draft, setDraft] = useState<CandidateDraft>(() => draftFrom(initialValue, initialDraft));
  const [tagText, setTagText] = useState(() => draftFrom(initialValue, initialDraft).tags.join("、"));
  const [desiredTitles, setDesiredTitles] = useState(() => draftFrom(initialValue, initialDraft).preferences.desired_titles.join("、"));
  const [desiredLocations, setDesiredLocations] = useState(() => draftFrom(initialValue, initialDraft).preferences.desired_locations.join("、"));
  const [error, setError] = useState("");
  const [includeAttachmentAvatar, setIncludeAttachmentAvatar] = useState(() => defaultAttachmentAvatarSelection(attachmentAvatar));
  const [activeSection, setActiveSection] = useState<FormSectionKey>("basic");
  const [tagInputOpen, setTagInputOpen] = useState(false);
  const [tagInputValue, setTagInputValue] = useState("");
  const sectionsRef = useRef<HTMLFieldSetElement | null>(null);
  const sectionNodes = useRef<Partial<Record<FormSectionKey, HTMLElement | null>>>({});
  const tagList = splitValues(tagText);
  const sourceOptions = Array.from(new Set([...SOURCES, draft.source].filter(Boolean)));
  const ownerOptions = Array.from(new Set([...OWNERS, draft.owner].filter(Boolean)));
  const genderOptions = Array.from(new Set(["男", "女", "其他", "未说明", draft.gender].filter(Boolean)));
  const educationOptions = Array.from(new Set([...EDUCATION_OPTIONS, draft.education].filter(Boolean)));
  const avatarConfidence = attachmentAvatar?.confidence === "high" ? "高置信" : attachmentAvatar?.confidence === "medium" ? "中等置信" : attachmentAvatar?.confidence === "low" ? "低置信" : "";
  const avatarDimensions = attachmentAvatar?.width && attachmentAvatar?.height ? `${attachmentAvatar.width} x ${attachmentAvatar.height}` : "";
  const avatarSourceLabel = attachmentAvatar?.source === "explicit_url" ? "外部头像地址，需手动确认使用" : "已识别内嵌证件照";
  useEffect(() => { const next = draftFrom(initialValue, initialDraft); setDraft(next); setTagText(next.tags.join("、")); setDesiredTitles(next.preferences.desired_titles.join("、")); setDesiredLocations(next.preferences.desired_locations.join("、")); setIncludeAttachmentAvatar(defaultAttachmentAvatarSelection(attachmentAvatar)); setError(""); }, [attachmentAvatar?.available, attachmentAvatar?.source, initialDraft, initialValue]);
  function update<K extends keyof CandidateDraft>(key: K, value: CandidateDraft[K]) { setDraft((current) => ({ ...current, [key]: value })); }
  function updatePreference<K extends keyof CandidateDraft["preferences"]>(key: K, value: CandidateDraft["preferences"][K]) { setDraft((current) => ({ ...current, preferences: { ...current.preferences, [key]: value } })); }
  function updateProfileSection(index: number, patch: Partial<CandidateProfileSectionDraft>) { setDraft((current) => { const sections = [...(current.profile_sections ?? [])]; if (!sections[index]) return current; sections[index] = { ...sections[index], ...patch }; return { ...current, profile_sections: sections }; }); }
  function addProfileSection() { setDraft((current) => ({ ...current, profile_sections: [...(current.profile_sections ?? []), sectionDraftFrom({ section_type: "other", title: "附加信息", content: "", sort_order: current.profile_sections?.length ?? 0, sensitivity: "internal" })] })); }
  function removeProfileSection(index: number) { setDraft((current) => ({ ...current, profile_sections: (current.profile_sections ?? []).filter((_, sectionIndex) => sectionIndex !== index).map((section, sectionIndex) => ({ ...section, sort_order: sectionIndex })) })); }
  function effectiveTagText() { return tagInputOpen && tagInputValue.trim() ? [...splitValues(tagText), ...splitValues(tagInputValue)].join("、") : tagText; }
  function commitTagInput() { const pending = splitValues(tagInputValue); if (pending.length) setTagText((prev) => Array.from(new Set([...splitValues(prev), ...pending])).slice(0, 8).join("、")); setTagInputValue(""); setTagInputOpen(false); }
  function removeTag(tag: string) { setTagText((prev) => splitValues(prev).filter((item) => item !== tag).join("、")); }
  function jumpToSection(key: FormSectionKey) { setActiveSection(key); sectionNodes.current[key]?.scrollIntoView({ behavior: "smooth", block: "start" }); }
  function trackActiveSection() {
    const container = sectionsRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    let current: FormSectionKey = "basic";
    for (const key of FORM_SECTION_KEYS) { const node = sectionNodes.current[key]; if (node && node.getBoundingClientRect().top - containerTop <= 36) current = key; }
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 4) current = "resume";
    setActiveSection((prev) => (prev === current ? prev : current));
  }
  function submit(event: FormEvent) { event.preventDefault(); if (!draft.name.trim()) return setError("请填写候选人姓名"); if (requireContact && !draft.phone.trim() && !draft.email.trim()) return setError("手机号和邮箱至少填写一项"); const salary = draft.preferences.expected_salary.trim(); const profileSections = draft.profile_sections?.filter((section) => !isLegacySummarySection(section)).map((section, index) => sectionDraftFrom({ ...section, title: section.title.trim(), content: section.content.trim(), sort_order: index })).filter(shouldPersistProfileSection); onSubmit({ ...draft, name: draft.name.trim(), tags: splitValues(effectiveTagText()).slice(0, 8), expected_salary: salary, preferences: { ...draft.preferences, desired_titles: splitValues(desiredTitles), desired_locations: splitValues(desiredLocations), expected_salary: salary }, profile_sections: profileSections }, { includeAttachmentAvatar: Boolean(attachmentAvatar?.available && includeAttachmentAvatar) }); }
  return <form className="tw-form tw-candidate-form" onSubmit={submit} aria-busy={busy || undefined}>
    <nav className="tw-form-anchors" aria-label="表单分区">
      <div className="tw-form-anchors-inner">
        {FORM_SECTIONS.map((section) => <button key={section.key} type="button" className={activeSection === section.key ? "active" : ""} aria-current={activeSection === section.key ? "true" : undefined} onClick={() => jumpToSection(section.key)}>{section.label}</button>)}
      </div>
    </nav>
    <fieldset className="tw-form-sections" ref={sectionsRef} onScroll={trackActiveSection} disabled={busy || fieldsDisabled}>
      <section className="tw-form-section" ref={(node) => { sectionNodes.current.basic = node; }} aria-labelledby="tw-form-heading-basic">
        <header className="tw-form-section-head"><h3 id="tw-form-heading-basic" className="tw-form-heading">基本信息</h3><p>用于识别候选人的核心信息</p></header>
        <div className="tw-field-grid tw-form-grid">
          <label className="tw-field"><span className="tw-field-label">姓名<span className="tw-req">*</span></span><input value={draft.name} onChange={(event) => update("name", event.target.value)} autoFocus /></label>
          <label className="tw-field"><span className="tw-field-label">性别</span><select value={draft.gender} onChange={(event) => update("gender", event.target.value)}><option value="">未填写</option>{genderOptions.map((gender) => <option key={gender}>{gender}</option>)}</select></label>
          <label className="tw-field"><span className="tw-field-label">所在城市</span><input value={draft.location} onChange={(event) => update("location", event.target.value)} /></label>
          <label className="tw-field"><span className="tw-field-label">手机号</span><input value={draft.phone} onChange={(event) => update("phone", event.target.value)} inputMode="tel" /></label>
          <label className="tw-field"><span className="tw-field-label">邮箱</span><input value={draft.email} onChange={(event) => update("email", event.target.value)} type="email" /></label>
          <label className="tw-field"><span className="tw-field-label">出生日期</span><input value={draft.birth_date?.slice(0, 10) ?? ""} onChange={(event) => update("birth_date", event.target.value || null)} type="date" /></label>
          <label className="tw-field"><span className="tw-field-label">年龄</span><input value={draft.age ?? ""} onChange={(event) => update("age", event.target.value === "" ? null : Math.max(0, Number(event.target.value)))} type="number" min="0" max="120" /></label>
          {attachmentAvatar?.available && <label className={`tw-att-avatar${includeAttachmentAvatar ? " is-selected" : ""}`}><span className="tw-att-avatar-icon"><ImageIcon size={18} /></span><span className="tw-att-avatar-copy"><strong>附件头像</strong><small>{[avatarSourceLabel, avatarConfidence, avatarDimensions].filter(Boolean).join(" · ")}</small></span><input type="checkbox" checked={includeAttachmentAvatar} onChange={(event) => setIncludeAttachmentAvatar(event.target.checked)} aria-label="创建时使用附件头像" /></label>}
        </div>
      </section>
      <section className="tw-form-section" ref={(node) => { sectionNodes.current.career = node; }} aria-labelledby="tw-form-heading-career">
        <header className="tw-form-section-head"><h3 id="tw-form-heading-career" className="tw-form-heading">职业与教育</h3><p>列表与人才检索使用的职业摘要</p></header>
        <div className="tw-field-grid tw-form-grid">
          <label className="tw-field"><span className="tw-field-label">最近公司</span><input value={draft.current_company} onChange={(event) => update("current_company", event.target.value)} /></label>
          <label className="tw-field"><span className="tw-field-label">最近职位</span><input value={draft.current_title} onChange={(event) => update("current_title", event.target.value)} /></label>
          <label className="tw-field"><span className="tw-field-label">工作年限</span><input value={draft.years_experience} onChange={(event) => update("years_experience", event.target.value)} /></label>
          <label className="tw-field"><span className="tw-field-label">简历更新日期</span><input value={draft.resume_updated_at?.slice(0, 10) ?? ""} onChange={(event) => update("resume_updated_at", event.target.value || null)} type="date" /></label>
          <label className="tw-field"><span className="tw-field-label">最高学历</span><select value={draft.education} onChange={(event) => update("education", event.target.value)}><option value="">未填写</option>{educationOptions.map((option) => <option key={option}>{option}</option>)}</select></label>
          <label className="tw-field"><span className="tw-field-label">最高学历学校</span><input value={draft.highest_school} onChange={(event) => update("highest_school", event.target.value)} /></label>
          <label className="tw-field"><span className="tw-field-label">最高学历专业</span><input value={draft.highest_major} onChange={(event) => update("highest_major", event.target.value)} /></label>
        </div>
        <div className="tw-form-group">
          <h4 className="tw-form-subhead">标签</h4>
          <div className="tw-tag-list">
            {tagList.map((tag) => <span className="tw-tag-removable" key={tag}>{tag}<button type="button" onClick={() => removeTag(tag)} aria-label={`移除标签 ${tag}`} title={`移除标签 ${tag}`}><X size={13} /></button></span>)}
            {tagInputOpen ? <input className="tw-tag-input" value={tagInputValue} autoFocus placeholder="输入后回车" onChange={(event) => setTagInputValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitTagInput(); } else if (event.key === "Escape") { event.preventDefault(); setTagInputValue(""); setTagInputOpen(false); } }} onBlur={commitTagInput} aria-label="新增标签" /> : <button className="tw-tag-add" type="button" disabled={tagList.length >= 8} onClick={() => setTagInputOpen(true)}><Plus size={14} />添加标签</button>}
          </div>
        </div>
        <div className="tw-form-group">
          <h4 className="tw-form-subhead">个人简介</h4>
          <textarea className="tw-textarea" value={draft.self_summary} onChange={(event) => update("self_summary", event.target.value)} rows={4} placeholder="候选人的职业概述、优势或自我评价" />
        </div>
      </section>
      <section className="tw-form-section" ref={(node) => { sectionNodes.current.preference = node; }} aria-labelledby="tw-form-heading-preference">
        <header className="tw-form-section-head"><h3 id="tw-form-heading-preference" className="tw-form-heading">求职偏好</h3><p>求职方向、入职安排与人才管理</p></header>
        <div className="tw-form-group tw-form-group-first">
          <h4 className="tw-form-subhead">求职意向</h4>
          <div className="tw-field-grid tw-form-grid">
            <label className="tw-field"><span className="tw-field-label">求职状态</span><input value={draft.job_seeking_status} onChange={(event) => { update("job_seeking_status", event.target.value); updatePreference("employment_status", event.target.value); }} placeholder="例如 在职看机会" /></label>
            <label className="tw-field"><span className="tw-field-label">工作性质</span><input value={draft.preferences.employment_type} onChange={(event) => updatePreference("employment_type", event.target.value)} placeholder="例如 全职" /></label>
            <label className="tw-field tw-field-full"><span className="tw-field-label">期望职位</span><input value={desiredTitles} onChange={(event) => setDesiredTitles(event.target.value)} placeholder="多个职位用顿号分隔" /></label>
            <label className="tw-field"><span className="tw-field-label">期望地点</span><input value={desiredLocations} onChange={(event) => setDesiredLocations(event.target.value)} placeholder="多个地点用顿号分隔" /></label>
            <label className="tw-field"><span className="tw-field-label">期望薪资</span><input value={draft.preferences.expected_salary} onChange={(event) => updatePreference("expected_salary", event.target.value)} placeholder="例如 25-30K" /></label>
            <label className="tw-field"><span className="tw-field-label">到岗时间</span><input value={draft.preferences.availability} onChange={(event) => updatePreference("availability", event.target.value)} placeholder="例如 一个月内" /></label>
          </div>
        </div>
        <div className="tw-form-group">
          <h4 className="tw-form-subhead">入职信息</h4>
          <div className="tw-field-grid tw-form-grid">
            <label className="tw-field"><span className="tw-field-label">入职状态</span><input value={draft.hire_status} onChange={(event) => update("hire_status", event.target.value)} placeholder="例如 待入职" /></label>
            <label className="tw-field"><span className="tw-field-label">入职日期</span><input value={draft.hire_date?.slice(0, 10) ?? ""} onChange={(event) => update("hire_date", event.target.value || null)} type="date" /></label>
            <label className="tw-field tw-field-full"><span className="tw-field-label">入职职位</span><input value={draft.hire_position} onChange={(event) => update("hire_position", event.target.value)} placeholder="例如 游戏服务端开发工程师" /></label>
          </div>
        </div>
        <div className="tw-form-group">
          <h4 className="tw-form-subhead">人才管理</h4>
          <div className="tw-field-grid tw-form-grid">
            <label className="tw-field"><span className="tw-field-label">有效来源</span><select value={draft.source} onChange={(event) => update("source", event.target.value)}>{sourceOptions.map((source) => <option key={source}>{source}</option>)}</select></label>
            <label className="tw-field"><span className="tw-field-label">人才负责人</span><select value={draft.owner} onChange={(event) => update("owner", event.target.value)}>{ownerOptions.map((owner) => <option key={owner}>{owner}</option>)}</select></label>
          </div>
        </div>
      </section>
      <section className="tw-form-section" ref={(node) => { sectionNodes.current.resume = node; }} aria-labelledby="tw-form-heading-resume">
        <header className="tw-form-section-head tw-form-section-head-row">
          <div><h3 id="tw-form-heading-resume" className="tw-form-heading">履历资料</h3><p>教育、工作、项目、实习和能力等资料区块</p></div>
          <button className="tw-btn tw-btn-sm" type="button" onClick={addProfileSection}><Plus size={15} />添加区块</button>
        </header>
        {(draft.profile_sections ?? []).length > 0 ? <div className="tw-resume-form-list">{draft.profile_sections?.map((section, index) => <article className="tw-resume-form-item" key={section.id || `new-section-${index}`}>
          <header className="tw-resume-form-item-head"><strong>区块 {index + 1}</strong><button className="tw-icon-plain tw-icon-plain-danger" type="button" onClick={() => removeProfileSection(index)} aria-label={`删除履历区块 ${index + 1}`} title="删除履历区块"><Trash2 size={15} /></button></header>
          <div className="tw-field-grid tw-form-grid">
            <label className="tw-field"><span className="tw-field-label">区块类型</span><select value={section.section_type} onChange={(event) => updateProfileSection(index, profileSectionTypePatch(section, event.target.value))}>{PROFILE_SECTION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <label className="tw-field"><span className="tw-field-label">标题</span><input value={section.title} onChange={(event) => updateProfileSection(index, { title: event.target.value })} placeholder={PROFILE_SECTION_LABELS[section.section_type] ?? "资料标题"} /></label>
            <label className="tw-field"><span className="tw-field-label">可见范围</span><select value={section.sensitivity ?? "internal"} onChange={(event) => updateProfileSection(index, { sensitivity: event.target.value as CandidateProfileSectionDraft["sensitivity"] })}><option value="public">公开</option><option value="internal">内部</option><option value="high">敏感</option></select></label>
            <label className="tw-field tw-field-full"><span className="tw-field-label">内容</span><textarea value={section.content} onChange={(event) => updateProfileSection(index, { content: event.target.value })} rows={4} placeholder="填写该履历区块的详细内容" /></label>
          </div>
        </article>)}</div> : <p className="tw-form-empty">暂无履历区块，点击右上角「添加区块」补充教育、工作或项目资料。</p>}
      </section>
    </fieldset>
    {statusMessage && <p className="tw-form-status" role="status">{statusMessage}</p>}
    {error && <p className="tw-form-error" role="alert">{error}</p>}
    <div className="tw-drawer-foot tw-form-foot">
      <button className="tw-btn" type="button" onClick={onCancel} disabled={busy}>取消</button>
      <button className="tw-btn tw-btn-primary" type="submit" disabled={busy}><Save size={16} />{busy ? "正在保存..." : submitLabel}</button>
    </div>
  </form>;

}
