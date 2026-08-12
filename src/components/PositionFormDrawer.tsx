import { FormEvent, useEffect, useMemo, useState } from "react";
import { AlertCircle, BriefcaseBusiness, Save, X } from "lucide-react";
import type { Position, PositionDraft, PositionStatus } from "../types";
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
  const [tagText, setTagText] = useState(() => (position?.tags ?? []).join("、"));
  const [validationError, setValidationError] = useState("");

  useEffect(() => {
    if (!mode) return;
    setDraft(draftFromPosition(position));
    setTagText((position?.tags ?? []).join("、"));
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

    const tags = Array.from(new Set(
      tagText
        .split(/[,，、]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ));
    if (tags.length > 50) {
      setValidationError("职位标签最多填写 50 个");
      return;
    }
    if (tags.some((tag) => tag.length > 80)) {
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
      tags,
    });
  }

  return (
    <div className="drawer-layer position-form-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <aside className="drawer position-form-drawer" role="dialog" aria-modal="true" aria-label={title} aria-busy={busy || undefined}>
        <header className="drawer-header position-form-header">
          <div className="position-form-heading">
            <span className="position-form-heading-icon"><BriefcaseBusiness size={18} /></span>
            <div><p className="drawer-kicker">职位管理</p><h2>{title}</h2></div>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="关闭" title="关闭">
            <X size={19} />
          </button>
        </header>

        <form className="position-form" onSubmit={submit}>
          <div className="position-form-scroll">
            <section className="position-form-section">
              <div className="position-form-section-heading"><h3>基本信息</h3><span>用于筛选、分组和识别职位</span></div>
              <div className="form-grid position-form-grid">
                <label className="field required-field field-wide">
                  <span>职位名称</span>
                  <input value={draft.title} onChange={(event) => update("title", event.target.value)} maxLength={200} autoFocus />
                </label>
                <label className="field">
                  <span>部门</span>
                  <input value={draft.department} onChange={(event) => update("department", event.target.value)} maxLength={100} />
                </label>
                <label className="field">
                  <span>工作地点</span>
                  <input value={draft.location} onChange={(event) => update("location", event.target.value)} maxLength={100} />
                </label>
                <label className="field">
                  <span>招聘负责人</span>
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
                <label className="field required-field">
                  <span>计划人数</span>
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
                <label className="field">
                  <span>职位状态</span>
                  <select value={draft.status} onChange={(event) => update("status", event.target.value as PositionStatus)}>
                    {statusOptions.map((status) => <option value={status} key={status}>{POSITION_STATUS_LABELS[status]}</option>)}
                  </select>
                </label>
                <label className="field field-wide">
                  <span>标签</span>
                  <input value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="例如：研发、急招、社招，用顿号分隔" />
                </label>
              </div>
            </section>

            <section className="position-form-section">
              <div className="position-form-section-heading"><h3>职位描述</h3><span>{draft.description.length} / 20000</span></div>
              <label className="field position-description-field">
                <span className="sr-only">职位描述</span>
                <textarea
                  value={draft.description}
                  onChange={(event) => update("description", event.target.value)}
                  maxLength={20000}
                  rows={10}
                  placeholder="填写岗位职责、任职要求和其他说明"
                />
              </label>
            </section>

            {(validationError || submitError) && (
              <div className="form-error position-form-error" role="alert">
                <AlertCircle size={16} />
                <span>{validationError || submitError}</span>
              </div>
            )}
          </div>

          <footer className="drawer-footer position-form-footer">
            <button className="button secondary-button" type="button" onClick={onClose} disabled={busy}>取消</button>
            <button className="button primary-button" type="submit" disabled={busy}>
              <Save size={16} />{busy ? "正在保存..." : mode === "create" ? "创建职位" : "保存修改"}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  );
}
