import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArrowLeft,
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  MapPin,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Unlink,
  UserPlus,
  UserRound,
  UsersRound,
} from "lucide-react";
import type { Candidate, Pagination, Position } from "../types";
import { formatDate } from "../utils";
import { useDismissableLayer } from "../useDismissableLayer";
import { PositionStatusBadge } from "./PositionStatusBadge";
import { TwAvatar } from "../views/TwAvatar";

export interface PositionDetailPageProps {
  position: Position;
  candidates: Candidate[];
  loading?: boolean;
  busy?: boolean;
  busyCandidateId?: string | null;
  pagination: Pagination;
  pageSize: 20 | 50 | 100;
  onBack: () => void;
  onEdit: (position: Position) => void;
  onArchive: (position: Position) => void;
  onRestore: (position: Position) => void;
  onDelete: (position: Position) => void;
  onAddExisting: (position: Position) => void;
  onCreateCandidate: (position: Position) => void;
  onOpenCandidate: (candidate: Candidate) => void;
  onUnlinkCandidate: (position: Position, candidate: Candidate) => void;
  onBulkUnlink: (position: Position, candidateIds: string[]) => void;
  onExport: (position: Position) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: 20 | 50 | 100) => void;
}

/* 设计图 15：面包屑 + 返回链接 + 标题行（状态徽标 / 编辑 / 更多）+ 事实行 + 职位说明 + 关联候选人表。 */
export function PositionDetailPage({
  position,
  candidates,
  loading = false,
  busy = false,
  busyCandidateId = null,
  pagination,
  pageSize,
  onBack,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
  onAddExisting,
  onCreateCandidate,
  onOpenCandidate,
  onUnlinkCandidate,
  onBulkUnlink,
  onExport,
  onPageChange,
  onPageSizeChange,
}: PositionDetailPageProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmingBulkUnlink, setConfirmingBulkUnlink] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const selectableCandidateIds = useMemo(
    () => candidates.filter((candidate) => !candidate.archived_at).map((candidate) => candidate.id),
    [candidates],
  );
  const candidateIdSet = useMemo(() => new Set(selectableCandidateIds), [selectableCandidateIds]);

  useEffect(() => {
    setSelectedIds((current) => new Set(Array.from(current).filter((id) => candidateIdSet.has(id))));
  }, [candidateIdSet]);

  useEffect(() => {
    setSelectedIds(new Set());
    setConfirmingBulkUnlink(false);
    setMenuOpen(false);
  }, [position.id]);

  useDismissableLayer({
    open: menuOpen,
    onClose: () => setMenuOpen(false),
    isInside: (target) => target instanceof Element && Boolean(target.closest(".tw-menu-wrap")),
  });

  const allSelected = selectableCandidateIds.length > 0 && selectableCandidateIds.every((id) => selectedIds.has(id));
  const archived = Boolean(position.archived_at);
  const canAddCandidates = !archived && position.status !== "closed";
  const page = pagination.total ? pagination.page : 1;
  const pageCount = Math.max(1, pagination.total_pages);

  function toggleCandidate(id: string) {
    if (!candidateIdSet.has(id)) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirmingBulkUnlink(false);
  }

  function toggleAll() {
    setSelectedIds(allSelected ? new Set() : new Set(selectableCandidateIds));
    setConfirmingBulkUnlink(false);
  }

  function confirmBulkUnlink() {
    if (!confirmingBulkUnlink) {
      setConfirmingBulkUnlink(true);
      return;
    }
    onBulkUnlink(position, Array.from(selectedIds));
    setConfirmingBulkUnlink(false);
  }

  return (
    <section className="tw-page" aria-label={`职位详情：${position.title}`}>
      <nav className="tw-crumbs" aria-label="面包屑">
        <button type="button" onClick={onBack} disabled={busy}>职位管理</button>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{position.title}</span>
      </nav>

      <header className="tw-detail-head">
        <div>
          <button className="tw-back-link" type="button" onClick={onBack} disabled={busy}>
            <ArrowLeft size={15} />返回职位列表
          </button>
          <div className="tw-detail-headline">
            <h1>{position.title}</h1>
            <PositionStatusBadge status={position.status} archived={archived} />
          </div>
          <div className="tw-detail-facts">
            <span><Building2 size={14} />{position.department || "未设置部门"}</span>
            <span><MapPin size={14} />{position.location || "未设置地点"}</span>
            <span><UsersRound size={14} />计划 {position.headcount} 人</span>
            <span><UserRound size={14} />负责人 {position.owner || "未分配"}</span>
          </div>
        </div>
        <div className="tw-page-actions">
          {!archived && (
            <button className="tw-btn tw-btn-primary" type="button" disabled={busy} onClick={() => onEdit(position)}>
              <Pencil size={15} />编辑职位
            </button>
          )}
          <div className="tw-menu-wrap">
            <button className="tw-btn" type="button" disabled={busy} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((current) => !current)}>
              更多<ChevronDown size={14} />
            </button>
            {menuOpen && (
              <div className="tw-menu" role="menu" aria-label="职位更多操作">
                {archived ? (
                  <>
                    <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); onRestore(position); }}><RotateCcw size={15} />恢复职位</button>
                    <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); onDelete(position); }}><Trash2 size={15} />永久删除</button>
                  </>
                ) : (
                  <>
                    <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); onEdit(position); }}><Pencil size={15} />编辑职位</button>
                    <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); onArchive(position); }}><Archive size={15} />归档职位</button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="tw-detail-body">
        <section className="tw-section">
          <h2 className="tw-section-title"><FileText size={16} />职位说明</h2>
          <p className="tw-position-description">{position.description || "暂无职位描述"}</p>
          {position.tags.length > 0 && <div className="tw-tags tw-position-tags">{position.tags.map((tag) => <span className="tw-tag" key={tag}>{tag}</span>)}</div>}
        </section>

        <section className="tw-section tw-linked">
          <header className="tw-card-head">
            <h2>关联候选人<span className="tw-count">{position.candidate_count}</span></h2>
            <div className="tw-section-actions">
              {canAddCandidates && (
                <button className="tw-btn tw-btn-primary" type="button" disabled={busy} onClick={() => onAddExisting(position)}>
                  <Plus size={15} />添加已有候选人
                </button>
              )}
              {canAddCandidates && (
                <button className="tw-btn" type="button" disabled={busy} onClick={() => onCreateCandidate(position)}>
                  <UserPlus size={15} />新增候选人
                </button>
              )}
              <button className="tw-btn" type="button" disabled={busy || !position.candidate_count} onClick={() => onExport(position)}>
                <Download size={15} />导出
              </button>
            </div>
          </header>

          {selectedIds.size > 0 && !archived && (
            <div className={`tw-bulk tw-bulk-inline${confirmingBulkUnlink ? " is-confirming" : ""}`}>
              <span className="tw-bulk-info"><Unlink size={15} />已选择 {selectedIds.size} 位候选人{confirmingBulkUnlink ? "，解除后仍保留在候选人库中" : ""}</span>
              <div className="tw-bulk-actions">
                {confirmingBulkUnlink && <button className="tw-btn tw-btn-sm" type="button" disabled={busy} onClick={() => setConfirmingBulkUnlink(false)}>取消</button>}
                <button className="tw-btn tw-btn-sm tw-btn-quiet-danger" type="button" disabled={busy} onClick={confirmBulkUnlink}>
                  {busy ? "正在解除..." : confirmingBulkUnlink ? "确认解除关联" : "批量解除关联"}
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="tw-skeleton" role="status" aria-label="正在加载关联候选人">
              {Array.from({ length: 5 }, (_, index) => (
                <div className="tw-skeleton-row" key={index}><span className="tw-skeleton-block tw-skeleton-avatar" /><span className="tw-skeleton-block tw-skeleton-line" /></div>
              ))}
            </div>
          ) : candidates.length ? (
            <>
              <div className="tw-table-scroll tw-linked-scroll">
                <table className="tw-table tw-linked-table">
                  <thead>
                    <tr>
                      <th className="tw-col-select"><input type="checkbox" checked={allSelected} disabled={busy || archived || !selectableCandidateIds.length} onChange={toggleAll} aria-label="选择全部未归档候选人" /></th>
                      <th>候选人</th>
                      <th>最近职位 / 最近公司</th>
                      <th>所在城市</th>
                      <th>人才分组</th>
                      <th>最近更新</th>
                      <th className="tw-col-actions">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((candidate) => {
                      const rowBusy = busyCandidateId === candidate.id;
                      const candidateArchived = Boolean(candidate.archived_at);
                      const selected = !candidateArchived && selectedIds.has(candidate.id);
                      return (
                        <tr className={`${selected ? "is-selected " : ""}${candidateArchived ? "is-archived" : ""}`.trim() || undefined} key={candidate.id} aria-busy={rowBusy || undefined} aria-selected={selected} onClick={() => !rowBusy && onOpenCandidate(candidate)}>
                          <td className="tw-col-select"><input type="checkbox" checked={selected} disabled={busy || archived || candidateArchived || rowBusy} onChange={() => toggleCandidate(candidate.id)} onClick={(event) => event.stopPropagation()} aria-label={`选择 ${candidate.name}`} /></td>
                          <td>
                            <div className="tw-cell-name">
                              <TwAvatar candidate={candidate} />
                              <span><strong>{candidate.name}</strong>{candidateArchived && <small>已归档</small>}</span>
                            </div>
                          </td>
                          <td>
                            <span className="tw-stack">
                              <strong>{candidate.current_title || "最近职位待补充"}</strong>
                              <small className="tw-more">{candidate.current_company || "最近公司待补充"}</small>
                            </span>
                          </td>
                          <td>{candidate.location || <span className="tw-empty-inline">未填写</span>}</td>
                          <td>
                            {candidate.talent_pools.length ? (
                              <div className="tw-pool-inline-list">
                                {candidate.talent_pools.slice(0, 2).map((pool) => (
                                  <span className="tw-pool-inline" key={pool.id}><span className="tw-dot" style={{ backgroundColor: pool.color }} />{pool.name}</span>
                                ))}
                                {candidate.talent_pools.length > 2 && <span className="tw-more">+{candidate.talent_pools.length - 2}</span>}
                              </div>
                            ) : <span className="tw-empty-inline">未分组</span>}
                          </td>
                          <td className="tw-col-time"><time dateTime={candidate.updated_at}>{formatDate(candidate.updated_at)}</time></td>
                          <td className="tw-col-actions" onClick={(event) => event.stopPropagation()}>
                            {!archived && !candidateArchived && (
                              <button className="tw-link-btn" type="button" disabled={busy || rowBusy} aria-label={`解除关联：${candidate.name}`} onClick={() => onUnlinkCandidate(position, candidate)}>
                                解除关联
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="tw-mini-pagination tw-linked-pagination">
                <label className="tw-page-size">
                  每页
                  <select value={pageSize} disabled={loading} onChange={(event) => onPageSizeChange(Number(event.target.value) as 20 | 50 | 100)}>
                    <option value={20}>20</option><option value={50}>50</option><option value={100}>100</option>
                  </select>
                </label>
                <span>共 {pagination.total} 位候选人</span>
                <div className="tw-pages">
                  <button className="tw-icon-btn" type="button" disabled={loading || page <= 1} onClick={() => onPageChange(page - 1)} aria-label="上一页"><ChevronLeft size={15} /></button>
                  <span className="tw-mini-page">{page} / {pagination.total ? pageCount : 0}</span>
                  <button className="tw-icon-btn" type="button" disabled={loading || !(pagination.has_next ?? page < pageCount)} onClick={() => onPageChange(page + 1)} aria-label="下一页"><ChevronRight size={15} /></button>
                </div>
              </div>
            </>
          ) : (
            <div className="tw-empty tw-detail-empty">
              <span className="tw-empty-icon"><UsersRound size={24} /></span>
              <p>{canAddCandidates ? "暂未关联候选人，可从候选人库添加，或直接新建并关联。" : position.status === "closed" ? "职位已关闭，不能再新增候选人关联。" : "该招聘职位已归档，恢复后可继续添加候选人。"}</p>
              {canAddCandidates && (
                <div className="tw-page-actions">
                  <button className="tw-btn" type="button" disabled={busy} onClick={() => onAddExisting(position)}><UserPlus size={15} />添加已有候选人</button>
                  <button className="tw-btn tw-btn-primary" type="button" disabled={busy} onClick={() => onCreateCandidate(position)}><Plus size={15} />新建并关联</button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
