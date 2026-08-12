import { FormEvent, useEffect, useState } from "react";
import { BriefcaseBusiness, CircleUserRound, GraduationCap, Save, Target } from "lucide-react";
import {
  EDUCATION_OPTIONS,
  emptyDraft,
  OWNERS,
  SOURCES,
  type Candidate,
  type CandidateDraft,
} from "../types";

interface CandidateFormProps {
  initialValue?: Candidate;
  initialDraft?: Partial<CandidateDraft>;
  submitLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (draft: CandidateDraft) => void;
}

function draftFrom(candidate?: Candidate, initialDraft?: Partial<CandidateDraft>): CandidateDraft {
  const base: CandidateDraft = candidate ? {
    name: candidate.name,
    phone: candidate.phone,
    email: candidate.email,
    gender: candidate.gender,
    birth_date: candidate.birth_date,
    age: candidate.age,
    current_company: candidate.current_company,
    current_title: candidate.current_title,
    location: candidate.location,
    years_experience: candidate.years_experience,
    education: candidate.education,
    highest_school: candidate.highest_school,
    highest_major: candidate.highest_major,
    job_seeking_status: candidate.job_seeking_status,
    resume_updated_at: candidate.resume_updated_at,
    self_summary: candidate.self_summary,
    source: candidate.source,
    stage: candidate.stage,
    owner: candidate.owner,
    tags: candidate.tags,
    expected_salary: candidate.expected_salary,
    preferences: {
      employment_status: candidate.preferences?.employment_status ?? "",
      desired_titles: candidate.preferences?.desired_titles ?? [],
      desired_locations: candidate.preferences?.desired_locations ?? [],
      employment_type: candidate.preferences?.employment_type ?? "",
      expected_salary: candidate.preferences?.expected_salary || candidate.expected_salary,
      availability: candidate.preferences?.availability ?? "",
    },
  } : { ...emptyDraft, tags: [...emptyDraft.tags], preferences: { ...emptyDraft.preferences } };
  return {
    ...base,
    ...initialDraft,
    tags: [...(initialDraft?.tags ?? base.tags)],
    preferences: { ...base.preferences, ...(initialDraft?.preferences ?? {}) },
  };
}

function splitValues(value: string) {
  return value.split(/[,，、]/).map((item) => item.trim()).filter(Boolean).slice(0, 20);
}

export function CandidateForm({ initialValue, initialDraft, submitLabel, busy = false, onCancel, onSubmit }: CandidateFormProps) {
  const [draft, setDraft] = useState<CandidateDraft>(() => draftFrom(initialValue, initialDraft));
  const [tagText, setTagText] = useState(() => draftFrom(initialValue, initialDraft).tags.join("、"));
  const [desiredTitles, setDesiredTitles] = useState(() => draftFrom(initialValue, initialDraft).preferences.desired_titles.join("、"));
  const [desiredLocations, setDesiredLocations] = useState(() => draftFrom(initialValue, initialDraft).preferences.desired_locations.join("、"));
  const [error, setError] = useState("");
  const sourceOptions = Array.from(new Set([...SOURCES, draft.source].filter(Boolean)));
  const ownerOptions = Array.from(new Set([...OWNERS, draft.owner].filter(Boolean)));
  const genderOptions = Array.from(new Set(["男", "女", "其他", "未说明", draft.gender].filter(Boolean)));

  useEffect(() => {
    const next = draftFrom(initialValue, initialDraft);
    setDraft(next);
    setTagText(next.tags.join("、"));
    setDesiredTitles(next.preferences.desired_titles.join("、"));
    setDesiredLocations(next.preferences.desired_locations.join("、"));
    setError("");
  }, [initialDraft, initialValue]);

  function update<K extends keyof CandidateDraft>(key: K, value: CandidateDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function updatePreference<K extends keyof CandidateDraft["preferences"]>(key: K, value: CandidateDraft["preferences"][K]) {
    setDraft((current) => ({ ...current, preferences: { ...current.preferences, [key]: value } }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.name.trim()) return setError("请填写候选人姓名");
    if (!draft.phone.trim() && !draft.email.trim()) return setError("手机号和邮箱至少填写一项");
    const salary = draft.preferences.expected_salary.trim();
    onSubmit({
      ...draft,
      name: draft.name.trim(),
      tags: splitValues(tagText).slice(0, 8),
      expected_salary: salary,
      preferences: {
        ...draft.preferences,
        desired_titles: splitValues(desiredTitles),
        desired_locations: splitValues(desiredLocations),
        expected_salary: salary,
      },
    });
  }

  return (
    <form className="candidate-form talent-candidate-form" onSubmit={submit} aria-busy={busy || undefined}>
      <div className="candidate-form-sections">
        <section className="candidate-form-section">
          <header><span><CircleUserRound size={16} /></span><div><h3>基本资料</h3><p>用于识别候选人的核心信息</p></div></header>
          <div className="form-grid">
            <label className="field required-field"><span>姓名</span><input value={draft.name} onChange={(event) => update("name", event.target.value)} autoFocus /></label>
            <label className="field"><span>所在地</span><input value={draft.location} onChange={(event) => update("location", event.target.value)} /></label>
            <label className="field"><span>性别</span><select value={draft.gender} onChange={(event) => update("gender", event.target.value)}><option value="">未填写</option>{genderOptions.map((gender) => <option key={gender}>{gender}</option>)}</select></label>
            <label className="field"><span>出生日期</span><input value={draft.birth_date?.slice(0, 10) ?? ""} onChange={(event) => update("birth_date", event.target.value || null)} type="date" /></label>
            <label className="field"><span>年龄</span><input value={draft.age ?? ""} onChange={(event) => update("age", event.target.value === "" ? null : Math.max(0, Number(event.target.value)))} type="number" min="0" max="120" /></label>
            <label className="field"><span>手机号</span><input value={draft.phone} onChange={(event) => update("phone", event.target.value)} inputMode="tel" /></label>
            <label className="field"><span>邮箱</span><input value={draft.email} onChange={(event) => update("email", event.target.value)} type="email" /></label>
            <label className="field field-wide"><span>自我评价</span><textarea value={draft.self_summary} onChange={(event) => update("self_summary", event.target.value)} rows={4} placeholder="候选人的职业概述、优势或自我评价" /></label>
          </div>
        </section>

        <section className="candidate-form-section">
          <header><span><BriefcaseBusiness size={16} /></span><div><h3>当前经历</h3><p>列表和人才检索使用的职业摘要</p></div></header>
          <div className="form-grid">
            <label className="field"><span>当前公司</span><input value={draft.current_company} onChange={(event) => update("current_company", event.target.value)} /></label>
            <label className="field"><span>当前职位</span><input value={draft.current_title} onChange={(event) => update("current_title", event.target.value)} /></label>
            <label className="field"><span>工作年限</span><input value={draft.years_experience} onChange={(event) => update("years_experience", Math.max(0, Number(event.target.value)))} type="number" min="0" max="60" /></label>
            <label className="field"><span>简历更新日期</span><input value={draft.resume_updated_at?.slice(0, 10) ?? ""} onChange={(event) => update("resume_updated_at", event.target.value || null)} type="date" /></label>
          </div>
        </section>

        <section className="candidate-form-section">
          <header><span><GraduationCap size={16} /></span><div><h3>教育与能力</h3><p>用于学历、学校和专业检索</p></div></header>
          <div className="form-grid">
            <label className="field"><span>最高学历</span><select value={draft.education} onChange={(event) => update("education", event.target.value)}>{EDUCATION_OPTIONS.map((option) => <option key={option}>{option}</option>)}</select></label>
            <label className="field"><span>最高学历学校</span><input value={draft.highest_school} onChange={(event) => update("highest_school", event.target.value)} /></label>
            <label className="field"><span>最高学历专业</span><input value={draft.highest_major} onChange={(event) => update("highest_major", event.target.value)} /></label>
          </div>
        </section>

        <section className="candidate-form-section">
          <header><span><Target size={16} /></span><div><h3>求职偏好</h3><p>求职方向与可入职安排</p></div></header>
          <div className="form-grid">
            <label className="field"><span>求职状态</span><input value={draft.job_seeking_status} onChange={(event) => { update("job_seeking_status", event.target.value); updatePreference("employment_status", event.target.value); }} placeholder="例如 在职看机会" /></label>
            <label className="field"><span>工作性质</span><input value={draft.preferences.employment_type} onChange={(event) => updatePreference("employment_type", event.target.value)} placeholder="例如 全职" /></label>
            <label className="field field-wide"><span>期望职位</span><input value={desiredTitles} onChange={(event) => setDesiredTitles(event.target.value)} placeholder="多个职位用顿号分隔" /></label>
            <label className="field"><span>期望地点</span><input value={desiredLocations} onChange={(event) => setDesiredLocations(event.target.value)} placeholder="多个地点用顿号分隔" /></label>
            <label className="field"><span>期望薪资</span><input value={draft.preferences.expected_salary} onChange={(event) => updatePreference("expected_salary", event.target.value)} placeholder="例如 25-30K" /></label>
            <label className="field"><span>到岗时间</span><input value={draft.preferences.availability} onChange={(event) => updatePreference("availability", event.target.value)} placeholder="例如 一个月内" /></label>
          </div>
        </section>

        <section className="candidate-form-section">
          <header><span><CircleUserRound size={16} /></span><div><h3>人才管理</h3><p>有效来源、负责人和检索标签</p></div></header>
          <div className="form-grid">
            <label className="field"><span>有效来源</span><select value={draft.source} onChange={(event) => update("source", event.target.value)}>{sourceOptions.map((source) => <option key={source}>{source}</option>)}</select></label>
            <label className="field"><span>人才负责人</span><select value={draft.owner} onChange={(event) => update("owner", event.target.value)}>{ownerOptions.map((owner) => <option key={owner}>{owner}</option>)}</select></label>
            <label className="field field-wide"><span>标签</span><input value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="用顿号分隔，最多 8 个" /></label>
          </div>
        </section>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="drawer-footer"><button className="button secondary-button" type="button" onClick={onCancel} disabled={busy}>取消</button><button className="button primary-button" type="submit" disabled={busy}><Save size={16} />{busy ? "正在保存..." : submitLabel}</button></div>
    </form>
  );
}
