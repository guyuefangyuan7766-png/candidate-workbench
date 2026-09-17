import { useMemo, useState } from "react";
import {
  Archive,
  BriefcaseBusiness,
  ChevronDown,
  ChevronRight,
  Link2,
  MapPin,
  Pencil,
  RotateCcw,
  UserRoundX,
} from "lucide-react";
import type { Candidate, Position } from "../types";
import { formatDateTime } from "../utils";
import { TwAvatar } from "./TwAvatar";

/* 设计图「按职位」视图：沿用列表信息层级，每组有真实职位标题与人数，未分配职位单独列组。 */

interface Group {
  id: string;
  position: Position | null;
  candidates: Candidate[];
}

const POSITION_STATUS_LABELS: Record<Position["status"], string> = {
  draft: "草稿",
  open: "招聘中",
  paused: "已暂停",
  closed: "已关闭",
};

function buildGroups(candidates: Candidate[]): Group[] {
  const byPosition = new Map<string, Group>();
  const unassigned: Candidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.positions.length) {
      unassigned.push(candidate);
      continue;
    }
    for (const position of candidate.positions) {
      const group = byPosition.get(position.id) ?? { id: position.id, position, candidates: [] };
      group.candidates.push(candidate);
      byPosition.set(position.id, group);
    }
  }
  const groups = [...byPosition.values()].sort((left, right) => {
    const leftPosition = left.position!;
    const rightPosition = right.position!;
    if (Boolean(leftPosition.archived_at) !== Boolean(rightPosition.archived_at)) return leftPosition.archived_at ? 1 : -1;
    return leftPosition.title.localeCompare(rightPosition.title, "zh-CN");
  });
  if (unassigned.length) groups.push({ id: "unassigned", position: null, candidates: unassigned });
  return groups;
}

export interface TwGroupedCandidatesProps {
  candidates: Candidate[];
  archived?: boolean;
  selection: ReadonlySet<string>;
  selectionKind: "active" | "archived" | null;
  onToggle: (candidateId: string) => void;
  onOpen: (candidate: Candidate) => void;
  onEdit: (candidate: Candidate) => void;
  onArchive: (candidate: Candidate) => void;
  onRestore: (candidate: Candidate) => void;
  onLinkPositions: (candidateIds: string[]) => void;
  onOpenPosition: (position: Position) => void;
}

export function TwGroupedCandidates(props: TwGroupedCandidatesProps) {
  const { candidates, archived = false, selection, selectionKind } = props;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const groups = useMemo(() => buildGroups(candidates), [candidates]);

  if (!groups.length) {
    return (
      <div className="tw-empty">
        <span className="tw-empty-icon"><UserRoundX size={24} /></span>
        <p>{archived ? "暂无已归档候选人" : "没有可按职位分组的候选人"}</p>
      </div>
    );
  }

  function toggleGroup(groupId: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  return (
    <div className="tw-grouped">
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.id);
        const activeIds = group.candidates.filter((candidate) => !candidate.archived_at).map((candidate) => candidate.id);
        return (
          <section className="tw-group" key={group.id}>
            <header className="tw-group-head">
              <button className="tw-group-toggle" type="button" onClick={() => toggleGroup(group.id)} aria-expanded={!isCollapsed} aria-controls={`tw-group-${group.id}`}>
                {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                <span className="tw-object-icon" style={{ width: 32, height: 32 }}>
                  {group.position ? <BriefcaseBusiness size={16} /> : <UserRoundX size={16} />}
                </span>
                <span className="tw-stack">
                  <strong>{group.position?.title ?? "未分配职位"}</strong>
                  <small className="tw-meta">
                    {group.position
                      ? [group.position.department, group.position.location].filter(Boolean).join(" · ") || "部门与地点未设置"
                      : "尚未关联招聘职位的候选人"}
                  </small>
                </span>
                {group.position && (
                  <span className={`tw-badge tw-badge-${group.position.archived_at ? "archived" : group.position.status}`}>
                    {group.position.archived_at ? "已归档" : POSITION_STATUS_LABELS[group.position.status]}
                  </span>
                )}
                <span className="tw-more">{group.candidates.length}</span>
              </button>
              <div className="tw-pane-actions">
                {group.position && !isCollapsed && (
                  <button className="tw-btn tw-btn-sm" type="button" onClick={() => props.onOpenPosition(group.position!)}>查看职位</button>
                )}
                <button className="tw-btn tw-btn-sm" type="button" disabled={!activeIds.length} onClick={() => props.onLinkPositions(activeIds)}>
                  <Link2 size={15} />关联职位
                </button>
              </div>
            </header>
            {!isCollapsed && (
              <div className="tw-group-list" id={`tw-group-${group.id}`}>
                {group.candidates.length ? group.candidates.map((candidate) => {
                  const candidateArchived = Boolean(candidate.archived_at);
                  const selected = selection.has(candidate.id);
                  const selectable = !selectionKind || selectionKind === (candidateArchived ? "archived" : "active");
                  const otherPositions = Math.max(0, candidate.positions.length - (group.position ? 1 : 0));
                  return (
                    <div className={`tw-group-row${selected ? " is-selected" : ""}`} key={candidate.id}>
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={!selectable}
                        aria-label={`选择 ${candidate.name}`}
                        onChange={() => props.onToggle(candidate.id)}
                      />
                      <button className="tw-group-open" type="button" onClick={() => props.onOpen(candidate)} aria-label={`查看候选人 ${candidate.name}`}>
                        <span className="tw-cell-name">
                          <TwAvatar candidate={candidate} />
                          <span className="tw-stack">
                            <strong>{candidate.name}</strong>
                            <small>{candidate.current_title || "最近职位未填写"}{candidate.current_company ? ` · ${candidate.current_company}` : ""}</small>
                          </span>
                        </span>
                        <span className="tw-meta">{candidate.talent_pools[0]?.name || candidate.source || "未加入人才库"}</span>
                        <span className="tw-meta"><MapPin size={12} />{candidate.location || "地点未填写"}</span>
                        <span className="tw-meta">{candidate.owner || "未分配负责人"}</span>
                        {otherPositions > 0 && <span className="tw-more">另关联 {otherPositions} 个职位</span>}
                        <time className="tw-col-time" dateTime={candidate.updated_at}>{formatDateTime(candidate.updated_at)}</time>
                      </button>
                      <div className="tw-row-actions">
                        {!candidateArchived && (
                          <button className="tw-icon-plain" type="button" onClick={() => props.onLinkPositions([candidate.id])} aria-label={`关联 ${candidate.name} 到职位`} title="关联职位"><Link2 size={15} /></button>
                        )}
                        {!candidateArchived ? (
                          <>
                            <button className="tw-icon-plain" type="button" onClick={() => props.onEdit(candidate)} aria-label={`编辑 ${candidate.name}`} title="编辑"><Pencil size={15} /></button>
                            <button className="tw-icon-plain" type="button" onClick={() => props.onArchive(candidate)} aria-label={`归档 ${candidate.name}`} title="归档"><Archive size={15} /></button>
                          </>
                        ) : (
                          <button className="tw-icon-plain" type="button" onClick={() => props.onRestore(candidate)} aria-label={`恢复 ${candidate.name}`} title="恢复"><RotateCcw size={15} /></button>
                        )}
                      </div>
                    </div>
                  );
                }) : <p className="tw-empty-inline" style={{ padding: "12px 16px" }}>当前筛选条件下没有候选人</p>}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
