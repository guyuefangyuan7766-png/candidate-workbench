import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BriefcaseBusiness,
  CalendarClock,
  ChevronDown,
  FileText,
  Save,
  Tag,
  X,
} from "lucide-react";
import type { Position, PositionDraft, PositionStatus } from "../types";
import { formatDateTime } from "../utils";
import { POSITION_STATUS_LABELS } from "./PositionStatusBadge";

export type PositionFormMode = "create" | "edit" | null;

export interface PositionFormDrawerProps {
  mode: PositionFormMode;
  position?: Position | null;
  ownerOptions?: string[];
  busy?: boolean;
  submitError?: string;
  onClose: () => void;
  onSubmit: (draft: PositionDraft) => void;
}

const statusOptions: PositionStatus[] = ["draft", "open", "paused", "closed"];

const emptyPositionDraft: PositionDraft = {
  title: "",
  department: "",
  location: "",
  owner: "",
  headcount: 1,
  status: "draft",
  description: "",
  tags: [],
};

function draftFromPosition(position?: Position | null): PositionDraft {
  if (!position) return { ...emptyPositionDraft, tags: [] };
  return {
    title: position.title,
    department: position.department,
    location: position.location,
    owner: position.owner,
    headcount: position.headcount,
    status: position.status,
    description: position.description,
    tags: [...position.tags],
  };
}

/* 设计图 16：抽屉式表单（基本信息 / 职位说明与标签 / 记录信息折叠 / 底部固定操作）。 */
export function PositionFormDrawer({
  mode,
  position,
  ownerOptions = [],
  busy = false,
  submitError = "",
  onClose,
  onSubmit,
}: PositionFormDrawerProps) {
  const [draft, setDraft] = useState<PositionDraft>(() => draftFromPosition(position));
  const [tags, setTags] = useState<string[]>(() => [...(position?.tags ?? [])]);
  const [tagInput, setTagInput] = useState("");
  const [validationError, setValidationError] = useState("");

  useEffect(() => {
    if (!mode) return;
    setDraft(draftFromPosition(position));
    setTags([...(position?.tags ?? [])]);
    setTagInput("");
    setValidationError("");
  }, [mode, position]);

  const availableOwners = useMemo(
    () => Array.from(new Set([...ownerOptions, draft.owner].map((owner) => owner.trim()).filter(Boolean))),
    [draft.owner, ownerOptions],
  );

  if (!mode) return null;

  const title = mode === "create" ? "新增职位" : "编辑职位";

  function update<K extends keyof PositionDraft>(key: K, value: PositionDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    if (validationError) setValidationError("");
  }

  function commitTag() {
    const candidate = tagInput.trim().replace(/[,，、]/g, "");
    if (!candidate) return;
    if (candidate.length > 80) {
      setValidationError("每个职位标签不能超过 80 个字符");
      return;
    }
    if (tags.includes(candidate)) {
      setTagInput("");
      return;
    }
    if (tags.length >= 50) {
      setValidationError("职位标签最多填写 50 个");
      return;
    }
    setTags([...tags, candidate]);
    setTagInput("");
    if (validationError) setValidationError("");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedTitle = draft.title.trim();
    if (!normalizedTitle) {
      setValidationError("请填写职位名称");
      return;
    }
    if (normalizedTitle.length > 200) {
      setValidationError("职位名称不能超过 200 个字符");
      return;
    }
    if (!Number.isInteger(draft.headcount) || draft.headcount < 1 || draft.headcount > 10000) {
      setValidationError("计划人数必须是 1 到 10000 之间的整数");
      return;
    }
    if (draft.description.trim().length > 20000) {
      setValidationError("职位描述不能超过 20000 个字符");
      return;
    }

    const pending = tagInput.trim().replace(/[,，、]/g, "");
    const normalizedTags = Array.from(new Set(pending ? [...tags, pending] : tags));
    if (normalizedTags.length > 50) {
      setValidationError("职位标签最多填写 50 个");
      return;
    }
    if (normalizedTags.some((tag) => tag.length > 80)) {
      setValidationError("每个职位标签不能超过 80 个字符");
      return;
    }

    onSubmit({
      ...draft,
      title: normalizedTitle,
      department: draft.department.trim(),
      location: draft.location.trim(),
      owner: draft.owner.trim(),
      description: draft.description.trim(),
      tags: normalizedTags,
    });
  }

  return (
    <div className="tw-drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <aside className="tw-drawer" role="dialog" aria-modal="true" aria-label={title} aria-busy={busy || undefined}>
        <header className="tw-drawer-head">
          <div className="tw-drawer-headline">
            <h2>{title}</h2>
          </div>
          <button className="tw-icon-plain" type="button" onClick={onClose} disabled={busy} aria-label="关闭" title="关闭">
            <X size={18} />
          </button>
        </header>

        <form className="tw-form" onSubmit={submit}>
          <div className="tw-form-body tw-form-body-plain">
            <section className="tw-form-section">
              <h3 className="tw-section-title"><BriefcaseBusiness size={16} />基本信息</h3>
              <div className="tw-field-grid">
                <label className="tw-field">
                  <span className="tw-field-label">职位名称<span className="tw-req">*</span></span>
                  <input value={draft.title} onChange={(event) => update("title", event.target.value)} maxLength={200} autoFocus placeholder="例如：高级产品设计师" />
                </label>
                <label className="tw-field">
                  <span className="tw-field-label">部门</span>
                  <input value={draft.department} onChange={(event) => update("department", event.target.value)} maxLength={100} placeholder="例如：产品中心" />
                </label>
                <label className="tw-field">
                  <span className="tw-field-label">工作地点</span>
                  <input value={draft.location} onChange={(event) => update("location", event.target.value)} maxLength={100} placeholder="例如：北京" />
                </label>
                <label className="tw-field">
                  <span className="tw-field-label">负责人</span>
                  <input
                    value={draft.owner}
                    onChange={(event) => update("owner", event.target.value)}
                    list={availableOwners.length ? "position-owner-options" : undefined}
                    maxLength={200}
                    placeholder="未分配，可直接输入新负责人"
                  />
                  {availableOwners.length > 0 && (
                    <datalist id="position-owner-options">
                      {availableOwners.map((owner) => <option value={owner} key={owner} />)}
                    </datalist>
                  )}
                </label>
                <label className="tw-field">
                  <span className="tw-field-label">状态</span>
                  <select value={draft.status} onChange={(event) => update("status", event.target.value as PositionStatus)}>
                    {statusOptions.map((status) => <option value={status} key={status}>{POSITION_STATUS_LABELS[status]}</option>)}
                  </select>
                </label>
                <label className="tw-field">
                  <span className="tw-field-label">计划人数<span className="tw-req">*</span></span>
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    step="1"
                    value={draft.headcount}
                    onChange={(event) => update("headcount", Number(event.target.value))}
                    inputMode="numeric"
                  />
                </label>
              </div>
            </section>

            <section className="tw-form-section">
              <h3 className="tw-section-title"><FileText size={16} />职位说明</h3>
              <div className="tw-field">
                <span className="tw-field-label">职位描述<span className="tw-req">*</span></span>
                <textarea
                  value={draft.description}
                  onChange={(event) => update("description", event.target.value)}
                  maxLength={20000}
                  rows={6}
                  placeholder="填写岗位职责、任职要求和其他说明"
                  aria-label="职位描述"
                />
                <span className="tw-counter">{draft.description.length} / 20000</span>
              </div>
              <div className="tw-field tw-tag-field">
                <span className="tw-field-label"><Tag size={13} />标签（选填）</span>
                <div className="tw-tag-input">
                  {tags.map((tag) => (
                    <span className="tw-tag-removable" key={tag}>
                      {tag}
                      <button type="button" onClick={() => setTags(tags.filter((item) => item !== tag))} aria-label={`移除标签 ${tag}`} title="移除"><X size={12} /></button>
                    </span>
                  ))}
                  <input
                    value={tagInput}
                    onChange={(event) => setTagInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") { event.preventDefault(); commitTag(); }
                      if (event.key === "Backspace" && !tagInput && tags.length) setTags(tags.slice(0, -1));
                    }}
                    onBlur={commitTag}
                    placeholder={tags.length ? "输入标签，按回车添加" : "输入标签，按回车添加"}
                    maxLength={80}
                    aria-label="新增职位标签"
                  />
                </div>
              </div>
            </section>

            <details className="tw-fold">
              <summary>
                <span className="tw-section-title"><CalendarClock size={16} />记录信息</span>
                <span className="tw-hint">创建时间、最近更新与归档记录</span>
                <ChevronDown size={16} className="tw-fold-arrow" />
              </summary>
              <dl className="tw-metadata-list">
                <div><dt>创建时间</dt><dd>{position ? formatDateTime(position.created_at) : "保存后生成"}</dd></div>
                <div><dt>最近更新</dt><dd>{position ? formatDateTime(position.updated_at) : "保存后生成"}</dd></div>
                <div><dt>归档时间</dt><dd>{position?.archived_at ? formatDateTime(position.archived_at) : "未归档"}</dd></div>
              </dl>
            </details>

            {(validationError || submitError) && (
              <div className="tw-form-error" role="alert">
                <AlertCircle size={16} />
                <span>{validationError || submitError}</span>
              </div>
            )}
          </div>

          <footer className="tw-drawer-foot">
            <button className="tw-btn tw-btn-wide" type="button" onClick={onClose} disabled={busy}>取消</button>
            <button className="tw-btn tw-btn-primary tw-btn-wide" type="submit" disabled={busy}>
              <Save size={15} />{busy ? "正在保存..." : mode === "create" ? "保存职位" : "保存修改"}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  );
}
