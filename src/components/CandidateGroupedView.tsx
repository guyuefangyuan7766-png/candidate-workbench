import { useMemo, useState } from "react";
import {
  Archive,
  BriefcaseBusiness,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Link2,
  MapPin,
  Pencil,
  RotateCcw,
  UserRoundX,
} from "lucide-react";
import type { Candidate, Position } from "../types";
import { formatDateTime } from "../utils";
import { CandidateAvatar } from "./CandidateAvatar";

interface CandidateGroup {
  id: string;
  position: Position | null;
  candidates: Candidate[];
}

interface CandidateGroupedViewProps {
  candidates: Candidate[];
  archived?: boolean;
  selectedIds?: ReadonlySet<string>;
  selectionKind?: "active" | "archived" | null;
  onToggle?: (candidateId: string) => void;
  onLinkPositions?: (candidateIds: string[]) => void;
  onOpen: (candidate: Candidate) => void;
  onEdit: (candidate: Candidate) => void;
  onArchive: (candidate: Candidate) => void;
  onRestore: (candidate: Candidate) => void;
  onOpenPosition?: (position: Position) => void;
}

const EMPTY_SELECTION = new Set<string>();

const POSITION_STATUS_LABELS: Record<Position["status"], string> = {
  draft: "草稿",
  open: "招聘中",
  paused: "已暂停",
  closed: "已关闭",
};

function buildGroups(candidates: Candidate[]): CandidateGroup[] {
  const groupsByPosition = new Map<string, CandidateGroup>();
  const unassigned: Candidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.positions.length) {
      unassigned.push(candidate);
      continue;
    }
    for (const position of candidate.positions) {
      const group = groupsByPosition.get(position.id) ?? { id: position.id, position, candidates: [] };
      group.candidates.push(candidate);
      groupsByPosition.set(position.id, group);
    }
  }

  const positionGroups = [...groupsByPosition.values()].sort((left, right) => {
    const leftPosition = left.position!;
    const rightPosition = right.position!;
    if (Boolean(leftPosition.archived_at) !== Boolean(rightPosition.archived_at)) return leftPosition.archived_at ? 1 : -1;
    return leftPosition.title.localeCompare(rightPosition.title, "zh-CN");
  });

  if (unassigned.length) {
    positionGroups.push({ id: "unassigned", position: null, candidates: unassigned });
  }
  return positionGroups;
}

export function CandidateGroupedView({
  candidates,
  archived = false,
  selectedIds = EMPTY_SELECTION,
  selectionKind = null,
  onToggle,
  onLinkPositions,
  onOpen,
  onEdit,
  onArchive,
  onRestore,
  onOpenPosition,
}: CandidateGroupedViewProps) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const groups = useMemo(() => buildGroups(candidates), [candidates]);

  function toggleGroup(groupId: string) {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  if (!groups.length) {
    return (
      <div className="empty-table-state">
        <p>{archived ? "暂无已归档候选人" : "没有可按职位分组的候选人"}</p>
      </div>
    );
  }

  return (
    <div className="candidate-grouped-view">
      {groups.map((group) => {
        const collapsed = collapsedIds.has(group.id);
        const activeCandidateIds = group.candidates.filter((candidate) => !candidate.archived_at).map((candidate) => candidate.id);
        const selectedCount = group.candidates.filter((candidate) => selectedIds.has(candidate.id)).length;
        return (
          <section className={`candidate-group${group.position?.archived_at ? " is-archived" : ""}`} key={group.id}>
            <header className="candidate-group-header">
              <button
                className="candidate-group-toggle"
                type="button"
                onClick={() => toggleGroup(group.id)}
                aria-expanded={!collapsed}
                aria-controls={`candidate-group-${group.id}`}
              >
                {collapsed ? <ChevronRight size={17} /> : <ChevronDown size={17} />}
                <span className="candidate-group-icon">
                  {group.position ? <BriefcaseBusiness size={17} /> : <UserRoundX size={17} />}
                </span>
                <span className="candidate-group-title">
                  <strong>{group.position?.title ?? "未分配职位"}</strong>
                  <small>
                    {group.position
                      ? [group.position.department, group.position.location].filter(Boolean).join(" · ") || "部门与地点未设置"
                      : "尚未关联招聘职位的候选人"}
                  </small>
                </span>
                {group.position && (
                  <span className={`position-status position-status-${group.position.status}`}>
                    {group.position.archived_at ? "已归档" : POSITION_STATUS_LABELS[group.position.status]}
                  </span>
                )}
                <span className="candidate-group-count">{group.candidates.length}</span>
              </button>
              <div className="candidate-group-actions">
                {selectedCount > 0 && <span>{selectedCount} 项已选</span>}
                {group.position && onOpenPosition && (
                  <button
                    className="icon-button compact-icon-button"
                    type="button"
                    onClick={() => onOpenPosition(group.position as Position)}
                    aria-label={`打开职位 ${group.position.title}`}
                    title="打开职位详情"
                  >
                    <ExternalLink size={15} />
                  </button>
                )}
                {onLinkPositions && activeCandidateIds.length > 0 && (
                  <button
                    className="button secondary-button"
                    type="button"
                    onClick={() => onLinkPositions(activeCandidateIds)}
                  >
                    <Link2 size={15} />关联职位
                  </button>
                )}
              </div>
            </header>

            {!collapsed && (
              <div className="candidate-group-list" id={`candidate-group-${group.id}`}>
                {group.candidates.length ? group.candidates.map((candidate) => {
                  const candidateArchived = Boolean(candidate.archived_at);
                  const selected = selectedIds.has(candidate.id);
                  const selectable = !selectionKind || selectionKind === (candidateArchived ? "archived" : "active");
                  const otherPositionCount = Math.max(0, candidate.positions.length - (group.position ? 1 : 0));
                  return (
                    <div
                      className={`candidate-group-row${selected ? " is-selected" : ""}${candidateArchived ? " is-archived" : ""}`}
                      key={candidate.id}
                    >
                      <input
                        className="candidate-checkbox"
                        type="checkbox"
                        checked={selected}
                        disabled={!onToggle || !selectable}
                        aria-label={`选择 ${candidate.name}`}
                        onChange={() => onToggle?.(candidate.id)}
                      />
                      <button
                        className="candidate-group-open"
                        type="button"
                        onClick={() => onOpen(candidate)}
                        aria-label={`查看候选人 ${candidate.name}`}
                      >
                        <div className="candidate-group-person">
                          <CandidateAvatar candidate={candidate} />
                          <span>
                            <strong>{candidate.name}</strong>
                            <small>{candidate.current_title || "当前职位未填写"}{candidate.current_company ? ` · ${candidate.current_company}` : ""}</small>
                          </span>
                        </div>
                        <div className="candidate-group-context">
                          <span>{candidate.talent_pools[0]?.name || candidate.source || "未加入人才库"}</span>
                          <span><MapPin size={12} />{candidate.location || "地点未填写"}</span>
                          <span>{candidate.owner || "未分配负责人"}</span>
                          {otherPositionCount > 0 && <span>另关联 {otherPositionCount} 个职位</span>}
                        </div>
                        <time className="updated-time" dateTime={candidate.updated_at}>{formatDateTime(candidate.updated_at)}</time>
                      </button>
                      <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                        {!candidateArchived && onLinkPositions && (
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
                        {!candidateArchived ? (
                          <>
                            <button className="icon-button compact-icon-button" type="button" onClick={() => onEdit(candidate)} aria-label={`编辑 ${candidate.name}`} title="编辑">
                              <Pencil size={15} />
                            </button>
                            <button className="icon-button compact-icon-button" type="button" onClick={() => onArchive(candidate)} aria-label={`归档 ${candidate.name}`} title="归档">
                              <Archive size={15} />
                            </button>
                          </>
                        ) : (
                          <button className="icon-button compact-icon-button" type="button" onClick={() => onRestore(candidate)} aria-label={`恢复 ${candidate.name}`} title="恢复">
                            <RotateCcw size={15} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                }) : (
                  <div className="candidate-group-empty">当前筛选条件下没有候选人</div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
