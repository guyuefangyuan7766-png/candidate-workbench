import { useEffect, useRef } from "react";
import {
  Archive,
  BriefcaseBusiness,
  Building2,
  MapPin,
  Pencil,
  RotateCcw,
  Trash2,
  UserRound,
  UsersRound,
} from "lucide-react";
import type { Position } from "../types";
import { formatDateTime } from "../utils";
import { PositionStatusBadge } from "./PositionStatusBadge";

export interface PositionTableProps {
  positions: Position[];
  loading?: boolean;
  busyPositionId?: string | null;
  emptyMessage?: string;
  onOpen: (position: Position) => void;
  onEdit: (position: Position) => void;
  onArchive: (position: Position) => void;
  onRestore: (position: Position) => void;
  selectedIds?: ReadonlySet<string>;
  selectionKind?: "active" | "archived" | null;
  onToggle?: (positionId: string) => void;
  onToggleAll?: (positionIds: string[], selected: boolean) => void;
  onDelete?: (position: Position) => void;
}

const EMPTY_SELECTION = new Set<string>();

function SelectionCheckbox({ checked, indeterminate = false, disabled = false, label, onChange }: { checked: boolean; indeterminate?: boolean; disabled?: boolean; label: string; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} className="candidate-checkbox" type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={onChange} onClick={(event) => event.stopPropagation()} />;
}

export function PositionTable({
  positions,
  loading = false,
  busyPositionId = null,
  emptyMessage = "没有符合条件的职位",
  onOpen,
  onEdit,
  onArchive,
  onRestore,
  selectedIds = EMPTY_SELECTION,
  selectionKind = null,
  onToggle,
  onToggleAll,
  onDelete,
}: PositionTableProps) {
  if (loading) {
    return (
      <div className="position-list-state position-list-loading" role="status">
        <span className="position-list-state-icon"><BriefcaseBusiness size={22} /></span>
        <p>正在加载职位...</p>
      </div>
    );
  }

  if (!positions.length) {
    return (
      <div className="position-list-state position-list-empty">
        <span className="position-list-state-icon"><BriefcaseBusiness size={22} /></span>
        <p>{emptyMessage}</p>
      </div>
    );
  }

  const positionKinds = new Set(positions.map((position) => position.archived_at ? "archived" : "active"));
  const headerSelectionKind = selectionKind
    ?? (positionKinds.size === 1 ? (positions[0].archived_at ? "archived" : "active") : null);
  const selectableIds = headerSelectionKind
    ? positions.filter((position) => (position.archived_at ? "archived" : "active") === headerSelectionKind).map((position) => position.id)
    : [];
  const selectedVisibleIds = selectableIds.filter((id) => selectedIds.has(id));
  const allSelected = selectableIds.length > 0 && selectedVisibleIds.length === selectableIds.length;
  const someSelected = selectedVisibleIds.length > 0 && !allSelected;

  return (
    <>
      <div className="position-table-frame">
        <table className="position-table">
          <colgroup>
            <col className="position-col-selection" />
            <col className="position-col-title" />
            <col className="position-col-status" />
            <col className="position-col-owner" />
            <col className="position-col-headcount" />
            <col className="position-col-candidates" />
            <col className="position-col-updated" />
            <col className="position-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th className="selection-column"><SelectionCheckbox checked={allSelected} indeterminate={someSelected} disabled={!onToggleAll || !selectableIds.length} label={`选择当前页全部${headerSelectionKind === "archived" ? "已归档" : "活动"}职位`} onChange={() => onToggleAll?.(selectableIds, !allSelected)} /></th>
              <th>职位</th>
              <th>状态</th>
              <th>负责人</th>
              <th>计划人数</th>
              <th>候选人</th>
              <th>最近更新</th>
              <th><span className="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => {
              const busy = busyPositionId === position.id;
              const selected = selectedIds.has(position.id);
              const positionKind = position.archived_at ? "archived" : "active";
              const selectable = !selectionKind || selectionKind === positionKind;
              return (
                <tr className={`${position.archived_at ? "is-archived" : ""}${selected ? " is-selected" : ""}`} key={position.id} aria-busy={busy || undefined} aria-selected={selected}>
                  <td className="selection-column"><SelectionCheckbox checked={selected} disabled={!onToggle || !selectable || busy} label={`选择 ${position.title}`} onChange={() => onToggle?.(position.id)} /></td>
                  <td>
                    <button className="position-title-cell" type="button" onClick={() => onOpen(position)}>
                      <span className="position-icon"><BriefcaseBusiness size={17} /></span>
                      <span className="position-title-copy">
                        <strong>{position.title}</strong>
                        <small>
                          <span><Building2 size={12} />{position.department || "未设置部门"}</span>
                          <span><MapPin size={12} />{position.location || "未设置地点"}</span>
                        </small>
                      </span>
                    </button>
                  </td>
                  <td><PositionStatusBadge status={position.status} archived={Boolean(position.archived_at)} /></td>
                  <td><span className="position-owner"><UserRound size={13} />{position.owner || "未分配"}</span></td>
                  <td><span className="position-number">{position.headcount} 人</span></td>
                  <td><span className="position-candidate-count"><UsersRound size={13} />{position.candidate_count}</span></td>
                  <td><time className="position-updated-time">{formatDateTime(position.updated_at)}</time></td>
                  <td>
                    <div className="position-row-actions">
                      {!position.archived_at && (
                        <button
                          className="icon-button compact-icon-button"
                          type="button"
                          disabled={busy}
                          onClick={() => onEdit(position)}
                          aria-label={`编辑 ${position.title}`}
                          title="编辑职位"
                        >
                          <Pencil size={15} />
                        </button>
                      )}
                      {position.archived_at ? (
                        <>
                          <button className="icon-button compact-icon-button" type="button" disabled={busy} onClick={() => onRestore(position)} aria-label={`恢复 ${position.title}`} title="恢复职位"><RotateCcw size={15} /></button>
                          {onDelete && <button className="icon-button compact-icon-button danger-icon-button" type="button" disabled={busy} onClick={() => onDelete(position)} aria-label={`永久删除 ${position.title}`} title="永久删除职位"><Trash2 size={15} /></button>}
                        </>
                      ) : (
                        <button
                          className="icon-button compact-icon-button"
                          type="button"
                          disabled={busy}
                          onClick={() => onArchive(position)}
                          aria-label={`归档 ${position.title}`}
                          title="归档职位"
                        >
                          <Archive size={15} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="position-mobile-list">
        <div className="position-mobile-select-all">
          <SelectionCheckbox checked={allSelected} indeterminate={someSelected} disabled={!onToggleAll || !selectableIds.length} label={`选择当前页全部${headerSelectionKind === "archived" ? "已归档" : "活动"}职位`} onChange={() => onToggleAll?.(selectableIds, !allSelected)} />
          <span>全选当前页{headerSelectionKind === "archived" ? "已归档" : "活动"}职位</span>
        </div>
        {positions.map((position) => {
          const busy = busyPositionId === position.id;
          const selected = selectedIds.has(position.id);
          const positionKind = position.archived_at ? "archived" : "active";
          const selectable = !selectionKind || selectionKind === positionKind;
          return (
            <article className={`position-mobile-item ${position.archived_at ? "is-archived" : ""}${selected ? " is-selected" : ""}`} key={position.id} aria-busy={busy || undefined}>
              <label className="position-mobile-selection"><SelectionCheckbox checked={selected} disabled={!onToggle || !selectable || busy} label={`选择 ${position.title}`} onChange={() => onToggle?.(position.id)} /></label>
              <button className="position-mobile-main" type="button" onClick={() => onOpen(position)}>
                <span className="position-icon"><BriefcaseBusiness size={17} /></span>
                <span className="position-title-copy">
                  <span className="position-mobile-title-line">
                    <strong>{position.title}</strong>
                    <PositionStatusBadge status={position.status} archived={Boolean(position.archived_at)} />
                  </span>
                  <small>{position.department || "未设置部门"} · {position.location || "未设置地点"}</small>
                </span>
              </button>
              <div className="position-mobile-meta">
                <span><UserRound size={13} />{position.owner || "未分配"}</span>
                <span><UsersRound size={13} />{position.candidate_count} 位候选人</span>
                <span>计划 {position.headcount} 人</span>
              </div>
              <div className="position-mobile-footer">
                <time>{formatDateTime(position.updated_at)}</time>
                <div className="position-row-actions">
                  {!position.archived_at && (
                    <button className="icon-button compact-icon-button" type="button" disabled={busy} onClick={() => onEdit(position)} aria-label={`编辑 ${position.title}`} title="编辑职位">
                      <Pencil size={15} />
                    </button>
                  )}
                  {position.archived_at ? (
                    <><button className="icon-button compact-icon-button" type="button" disabled={busy} onClick={() => onRestore(position)} aria-label={`恢复 ${position.title}`} title="恢复职位"><RotateCcw size={15} /></button>{onDelete && <button className="icon-button compact-icon-button danger-icon-button" type="button" disabled={busy} onClick={() => onDelete(position)} aria-label={`永久删除 ${position.title}`} title="永久删除职位"><Trash2 size={15} /></button>}</>
                  ) : (
                    <button className="icon-button compact-icon-button" type="button" disabled={busy} onClick={() => onArchive(position)} aria-label={`归档 ${position.title}`} title="归档职位">
                      <Archive size={15} />
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
