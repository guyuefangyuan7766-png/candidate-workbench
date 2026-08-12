import { useEffect, useRef } from "react";
import {
  Archive,
  BriefcaseBusiness,
  Ellipsis,
  FolderKanban,
  GraduationCap,
  Link2,
  Mail,
  MapPin,
  Pencil,
  Phone,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type { Candidate, Position } from "../types";
import { formatDateTime, maskEmail, maskPhone } from "../utils";
import { CandidateAvatar } from "./CandidateAvatar";

interface CandidateTableProps {
  candidates: Candidate[];
  archived?: boolean;
  selectedIds?: ReadonlySet<string>;
  selectionKind?: "active" | "archived" | null;
  onToggle?: (candidateId: string) => void;
  onToggleAll?: (candidateIds: string[], selected: boolean) => void;
  onLinkPositions?: (candidateIds: string[]) => void;
  onOpen: (candidate: Candidate) => void;
  onEdit: (candidate: Candidate) => void;
  onArchive: (candidate: Candidate) => void;
  onRestore: (candidate: Candidate) => void;
  onDelete?: (candidate: Candidate) => void;
}

interface SelectionCheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}

const EMPTY_SELECTION = new Set<string>();

const POSITION_STATUS_LABELS: Record<Position["status"], string> = {
  draft: "草稿",
  open: "招聘中",
  paused: "已暂停",
  closed: "已关闭",
};

function SelectionCheckbox({ checked, indeterminate = false, disabled = false, label, onChange }: SelectionCheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      className="candidate-checkbox"
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={onChange}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

function CandidatePositions({ positions }: { positions: Position[] }) {
  if (!positions.length) return <span className="candidate-position-empty">未分配职位</span>;

  return (
    <div className="candidate-position-list">
      {positions.slice(0, 2).map((position) => (
        <span
          className={`candidate-position-chip position-status-${position.status}${position.archived_at ? " is-archived" : ""}`}
          key={position.id}
          title={`${position.title} · ${position.archived_at ? "已归档" : POSITION_STATUS_LABELS[position.status]}`}
        >
          <BriefcaseBusiness size={12} />
          <span>{position.title}</span>
        </span>
      ))}
      {positions.length > 2 && <span className="candidate-position-more">+{positions.length - 2}</span>}
    </div>
  );
}

function CandidatePools({ candidate }: { candidate: Candidate }) {
  if (!candidate.talent_pools.length) return <span className="candidate-position-empty">未加入人才库</span>;
  return (
    <div className="candidate-pool-list">
      {candidate.talent_pools.slice(0, 2).map((pool) => (
        <span className="candidate-pool-chip" key={pool.id} title={pool.name}>
          <span className="pool-color" style={{ backgroundColor: pool.color }} />
          <span>{pool.name}</span>
        </span>
      ))}
      {candidate.talent_pools.length > 2 && <span className="candidate-position-more">+{candidate.talent_pools.length - 2}</span>}
    </div>
  );
}

function CandidateActions({
  candidate,
  archived,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
  onLinkPositions,
}: Pick<CandidateTableProps, "archived" | "onEdit" | "onArchive" | "onRestore" | "onDelete" | "onLinkPositions"> & {
  candidate: Candidate;
}) {
  return (
    <div className="row-actions" onClick={(event) => event.stopPropagation()}>
      {!archived && onLinkPositions && (
        <button
          className="icon-button compact-icon-button"
          type="button"
          onClick={() => onLinkPositions([candidate.id])}
          aria-label={`关联 ${candidate.name} 到职位`}
          title="关联职位"
        >
          <Link2 size={15} />
        </button>
      )}
      {!archived && (
        <>
          <button
            className="icon-button compact-icon-button"
            type="button"
            onClick={() => onEdit(candidate)}
            aria-label={`编辑 ${candidate.name}`}
            title="编辑"
          >
            <Pencil size={15} />
          </button>
          <button
            className="icon-button compact-icon-button"
            type="button"
            onClick={() => onArchive(candidate)}
            aria-label={`归档 ${candidate.name}`}
            title="归档"
          >
            <Archive size={15} />
          </button>
        </>
      )}
      {archived && (
        <>
          <button
            className="icon-button compact-icon-button"
            type="button"
            onClick={() => onRestore(candidate)}
            aria-label={`恢复 ${candidate.name}`}
            title="恢复"
          >
            <RotateCcw size={15} />
          </button>
          {onDelete && (
            <details className="row-danger-menu">
              <summary
                className="icon-button compact-icon-button"
                aria-label={`更多操作 ${candidate.name}`}
                title="更多操作"
              >
                <Ellipsis size={15} />
              </summary>
              <div className="row-danger-menu-popover" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open");
                    onDelete(candidate);
                  }}
                >
                  <Trash2 size={14} />
                  永久删除
                </button>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

export function CandidateTable({
  candidates,
  archived = false,
  selectedIds = EMPTY_SELECTION,
  selectionKind = null,
  onToggle,
  onToggleAll,
  onLinkPositions,
  onOpen,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
}: CandidateTableProps) {
  if (!candidates.length) {
    return (
      <div className="empty-table-state">
        <p>{archived ? "暂无已归档候选人" : "没有符合条件的候选人"}</p>
      </div>
    );
  }

  const candidateKinds = new Set(candidates.map((candidate) => candidate.archived_at ? "archived" : "active"));
  const headerSelectionKind = selectionKind
    ?? (candidateKinds.size === 1 ? (candidates[0].archived_at ? "archived" : "active") : null);
  const selectableCandidateIds = headerSelectionKind
    ? candidates.filter((candidate) => (candidate.archived_at ? "archived" : "active") === headerSelectionKind).map((candidate) => candidate.id)
    : [];
  const selectedCandidateIds = selectableCandidateIds.filter((id) => selectedIds.has(id));
  const allSelected = selectableCandidateIds.length > 0 && selectedCandidateIds.length === selectableCandidateIds.length;
  const someSelected = selectedCandidateIds.length > 0 && !allSelected;
  const selectionEnabled = Boolean(onToggle && onToggleAll && selectableCandidateIds.length);

  function openFromKeyboard(event: React.KeyboardEvent, candidate: Candidate) {
    if (event.target !== event.currentTarget || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    onOpen(candidate);
  }

  return (
    <div className="candidate-list-surface">
      <div className="table-frame candidate-desktop-table">
        <table className="candidate-table">
          <thead>
            <tr>
              <th className="selection-column">
                <SelectionCheckbox
                  checked={allSelected}
                  indeterminate={someSelected}
                  disabled={!selectionEnabled}
                  label="选择当前列表全部候选人"
                  onChange={() => onToggleAll?.(selectableCandidateIds, !allSelected)}
                />
              </th>
              <th>候选人</th>
              <th>当前经历</th>
              <th>关联职位</th>
              <th>人才库</th>
              <th>地点</th>
              <th>标签</th>
              <th>更新时间</th>
              <th className="action-column"><span className="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((candidate) => {
              const candidateArchived = Boolean(candidate.archived_at);
              const selected = selectedIds.has(candidate.id);
              const selectable = !selectionKind || selectionKind === (candidateArchived ? "archived" : "active");
              return (
                <tr
                  className={`${selected ? "is-selected" : ""}${candidateArchived ? " is-archived" : ""}`.trim()}
                  key={candidate.id}
                  aria-selected={selected}
                  onClick={() => onOpen(candidate)}
                  tabIndex={0}
                  onKeyDown={(event) => openFromKeyboard(event, candidate)}
                >
                  <td className="selection-column" onClick={(event) => event.stopPropagation()}>
                    <SelectionCheckbox
                      checked={selected}
                      disabled={!onToggle || !selectable}
                      label={`选择 ${candidate.name}`}
                      onChange={() => onToggle?.(candidate.id)}
                    />
                  </td>
                  <td>
                    <div className="candidate-cell">
                      <CandidateAvatar candidate={candidate} />
                      <span className="candidate-cell-main">
                        <strong>{candidate.name}</strong>
                        <span title={candidate.phone || candidate.email || "联系方式受保护"}>
                          <Phone size={11} />{candidate.phone ? maskPhone(candidate.phone) : candidate.email ? maskEmail(candidate.email) : "联系方式受保护"}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className="experience-cell">
                      <strong>{candidate.current_title || "未填写"}</strong>
                      <span>{candidate.current_company || "当前公司未填写"}</span>
                    </div>
                  </td>
                  <td><CandidatePositions positions={candidate.positions} /></td>
                  <td><CandidatePools candidate={candidate} /></td>
                  <td><div className="candidate-location-stack"><span className="candidate-location"><MapPin size={12} />{candidate.location || "-"}</span><small><GraduationCap size={11} />{candidate.education || "学历未填写"}</small></div></td>
                  <td>
                    <div className="candidate-tag-list">
                      {candidate.tags.slice(0, 2).map((tag) => <span className="tag" key={tag}>{tag}</span>)}
                      {candidate.tags.length > 2 && <span className="candidate-tag-more">+{candidate.tags.length - 2}</span>}
                      {!candidate.tags.length && <span className="muted-value">-</span>}
                    </div>
                  </td>
                  <td><time className="updated-time" dateTime={candidate.updated_at}>{formatDateTime(candidate.updated_at)}</time></td>
                  <td className="action-column">
                    <CandidateActions
                      candidate={candidate}
                      archived={candidateArchived}
                      onEdit={onEdit}
                      onArchive={onArchive}
                      onRestore={onRestore}
                      onDelete={onDelete}
                      onLinkPositions={onLinkPositions}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="candidate-mobile-list">
        {candidates.map((candidate) => {
          const candidateArchived = Boolean(candidate.archived_at);
          const selected = selectedIds.has(candidate.id);
          const selectable = !selectionKind || selectionKind === (candidateArchived ? "archived" : "active");
          return (
            <article
              className={`candidate-mobile-item${selected ? " is-selected" : ""}${candidateArchived ? " is-archived" : ""}`}
              key={candidate.id}
            >
              <div className="candidate-mobile-select">
                <SelectionCheckbox
                  checked={selected}
                  disabled={!onToggle || !selectable}
                  label={`选择 ${candidate.name}`}
                  onChange={() => onToggle?.(candidate.id)}
                />
              </div>
              <button
                className="candidate-mobile-open"
                type="button"
                onClick={() => onOpen(candidate)}
                aria-label={`查看候选人 ${candidate.name}`}
              >
                <div className="candidate-mobile-head">
                  <CandidateAvatar candidate={candidate} />
                  <div>
                    <strong>{candidate.name}</strong>
                    <span>{candidate.current_title || "当前职位未填写"}{candidate.current_company ? ` · ${candidate.current_company}` : ""}</span>
                  </div>
                </div>
                <CandidatePositions positions={candidate.positions} />
                <CandidatePools candidate={candidate} />
                <div className="candidate-mobile-meta">
                  <span><Phone size={12} />{candidate.phone ? maskPhone(candidate.phone) : "联系方式受保护"}</span>
                  <span><MapPin size={12} />{candidate.location || "地点未填写"}</span>
                  <span><Mail size={12} />{candidate.email ? maskEmail(candidate.email) : "联系方式受保护"}</span>
                </div>
              </button>
              <div className="candidate-mobile-foot">
                <span>{candidate.source || "来源未设置"} · {candidate.owner || "未分配负责人"} · {formatDateTime(candidate.updated_at)}</span>
                <CandidateActions
                  candidate={candidate}
                  archived={candidateArchived}
                  onEdit={onEdit}
                  onArchive={onArchive}
                  onRestore={onRestore}
                  onDelete={onDelete}
                  onLinkPositions={onLinkPositions}
                />
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
