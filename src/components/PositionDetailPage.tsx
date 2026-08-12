import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArrowLeft,
  BriefcaseBusiness,
  Building2,
  ChevronLeft,
  ChevronRight,
  Download,
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
import { formatDate, formatDateTime, maskEmail, maskPhone } from "../utils";
import { CandidateAvatar } from "./CandidateAvatar";
import { PositionStatusBadge } from "./PositionStatusBadge";

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
  }, [position.id]);

  const allSelected = selectableCandidateIds.length > 0 && selectableCandidateIds.every((id) => selectedIds.has(id));
  const archived = Boolean(position.archived_at);
  const canAddCandidates = !archived && position.status !== "closed";

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
    <div className="position-detail-page">
      <header className="position-detail-header">
        <button className="icon-button position-back-button" type="button" onClick={onBack} disabled={busy} aria-label="返回职位列表" title="返回职位列表">
          <ArrowLeft size={19} />
        </button>
        <span className="position-detail-icon"><BriefcaseBusiness size={21} /></span>
        <div className="position-detail-title">
          <div><h1>{position.title}</h1><PositionStatusBadge status={position.status} archived={archived} /></div>
          <p>{position.department || "未设置部门"}{position.location ? ` · ${position.location}` : ""}</p>
        </div>
        <div className="position-detail-actions">
          <button className="button secondary-button" type="button" disabled={busy || !position.candidate_count} onClick={() => onExport(position)}>
            <Download size={16} />导出候选人
          </button>
          {!archived && (
            <button className="button secondary-button" type="button" disabled={busy} onClick={() => onEdit(position)}>
              <Pencil size={16} />编辑职位
            </button>
          )}
          {archived ? (
            <><button className="button danger-quiet-button" type="button" disabled={busy} onClick={() => onDelete(position)}><Trash2 size={16} />永久删除</button><button className="button primary-button" type="button" disabled={busy} onClick={() => onRestore(position)}><RotateCcw size={16} />{busy ? "正在恢复..." : "恢复职位"}</button></>
          ) : (
            <button className="button danger-quiet-button" type="button" disabled={busy} onClick={() => onArchive(position)}>
              <Archive size={16} />{busy ? "正在处理..." : "归档职位"}
            </button>
          )}
        </div>
      </header>

      <div className="position-detail-layout">
        <main className="position-candidates-panel">
          <div className="position-panel-heading">
            <div>
              <h2>关联候选人</h2>
              <span>{position.candidate_count} 位</span>
            </div>
            {canAddCandidates && (
              <div className="position-candidate-actions">
                <button className="button secondary-button" type="button" disabled={busy} onClick={() => onAddExisting(position)}>
                  <UserPlus size={16} />添加已有候选人
                </button>
                <button className="button primary-button" type="button" disabled={busy} onClick={() => onCreateCandidate(position)}>
                  <Plus size={16} />新建并关联
                </button>
              </div>
            )}
          </div>

          {selectedIds.size > 0 && !archived && (
            <div className={`position-bulk-bar ${confirmingBulkUnlink ? "is-confirming" : ""}`}>
              <strong>已选择 {selectedIds.size} 位候选人</strong>
              <span>{confirmingBulkUnlink ? "解除后候选人仍保留在候选人库中。" : "可批量解除与当前职位的关联。"}</span>
              <div>
                {confirmingBulkUnlink && <button className="button secondary-button" type="button" disabled={busy} onClick={() => setConfirmingBulkUnlink(false)}>取消</button>}
                <button className="button danger-quiet-button" type="button" disabled={busy} onClick={confirmBulkUnlink}>
                  <Unlink size={16} />{busy ? "正在解除..." : confirmingBulkUnlink ? "确认解除关联" : "批量解除关联"}
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="position-candidate-state" role="status"><UsersRound size={24} /><p>正在加载关联候选人...</p></div>
          ) : candidates.length ? (
            <>
              <div className="position-candidate-table-frame">
                <table className="position-candidate-table">
                  <thead>
                    <tr>
                      <th className="selection-column"><input type="checkbox" checked={allSelected} disabled={busy || archived || !selectableCandidateIds.length} onChange={toggleAll} aria-label="选择全部未归档候选人" /></th>
                      <th>候选人</th>
                      <th>当前经历</th>
                      <th>人才库</th>
                      <th>负责人</th>
                      <th>最近更新</th>
                      <th><span className="sr-only">操作</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((candidate) => {
                      const rowBusy = busyCandidateId === candidate.id;
                      const candidateArchived = Boolean(candidate.archived_at);
                      const selected = !candidateArchived && selectedIds.has(candidate.id);
                      return (
                        <tr className={`${selected ? "is-selected" : ""}${candidateArchived ? " is-archived" : ""}`.trim()} key={candidate.id} aria-busy={rowBusy || undefined}>
                          <td className="selection-column"><input type="checkbox" checked={selected} disabled={busy || archived || candidateArchived || rowBusy} onChange={() => toggleCandidate(candidate.id)} aria-label={`选择 ${candidate.name}`} /></td>
                          <td>
                            <button className="position-candidate-identity" type="button" onClick={() => onOpenCandidate(candidate)}>
                              <CandidateAvatar candidate={candidate} />
                              <span><strong>{candidate.name}</strong><small>{candidate.phone ? maskPhone(candidate.phone) : candidate.email ? maskEmail(candidate.email) : "联系方式受保护"}</small></span>
                            </button>
                          </td>
                          <td><span className="position-candidate-experience"><strong>{candidate.current_title || "-"}</strong><small>{candidate.current_company || "-"}{candidate.location ? ` · ${candidate.location}` : ""}</small></span></td>
                          <td>{candidate.talent_pools.slice(0, 2).map((pool) => <span className="candidate-pool-chip" key={pool.id}><span className="pool-color" style={{ backgroundColor: pool.color }} /><span>{pool.name}</span></span>)}{!candidate.talent_pools.length && <span className="muted-value">未分组</span>}</td>
                          <td>{candidate.owner || "未分配"}</td>
                          <td><time>{formatDateTime(candidate.updated_at)}</time></td>
                          <td>
                            {!archived && !candidateArchived && (
                              <button className="icon-button compact-icon-button" type="button" disabled={busy || rowBusy} onClick={() => onUnlinkCandidate(position, candidate)} aria-label={`解除 ${candidate.name} 与当前职位的关联`} title="解除关联">
                                <Unlink size={15} />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="position-candidate-mobile-list">
                {candidates.map((candidate) => {
                  const rowBusy = busyCandidateId === candidate.id;
                  const candidateArchived = Boolean(candidate.archived_at);
                  const selected = !candidateArchived && selectedIds.has(candidate.id);
                  return (
                    <article className={`position-candidate-mobile-item${selected ? " is-selected" : ""}${candidateArchived ? " is-archived" : ""}`} key={candidate.id} aria-busy={rowBusy || undefined}>
                      <label className="position-candidate-mobile-check">
                        <input type="checkbox" checked={selected} disabled={busy || archived || candidateArchived || rowBusy} onChange={() => toggleCandidate(candidate.id)} />
                        <span className="sr-only">选择 {candidate.name}</span>
                      </label>
                      <button className="position-candidate-identity" type="button" onClick={() => onOpenCandidate(candidate)}>
                        <CandidateAvatar candidate={candidate} />
                        <span><strong>{candidate.name}</strong><small>{candidate.current_title || "职位待补充"}{candidate.current_company ? ` · ${candidate.current_company}` : ""}</small></span>
                      </button>
                      <span className="candidate-mobile-pool">{candidate.talent_pools[0]?.name || candidate.source || "未分组"}</span>
                      {!archived && !candidateArchived && (
                        <button className="icon-button compact-icon-button" type="button" disabled={busy || rowBusy} onClick={() => onUnlinkCandidate(position, candidate)} aria-label={`解除 ${candidate.name} 与当前职位的关联`} title="解除关联">
                          <Unlink size={15} />
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="position-candidate-state position-candidate-empty">
              <UsersRound size={26} />
              <h3>暂未关联候选人</h3>
              <p>{canAddCandidates ? "候选人仍保留在候选人库中，可随时关联到这个职位。" : position.status === "closed" ? "职位已关闭，不能新增候选人关联。" : "职位已归档，恢复后可继续添加候选人。"}</p>
              {canAddCandidates && (
                <div>
                  <button className="button secondary-button" type="button" disabled={busy} onClick={() => onAddExisting(position)}><UserPlus size={16} />添加已有候选人</button>
                  <button className="button primary-button" type="button" disabled={busy} onClick={() => onCreateCandidate(position)}><Plus size={16} />新建并关联</button>
                </div>
              )}
            </div>
          )}
          <div className="entity-pagination">
            <label>每页<select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value) as 20 | 50 | 100)}><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option></select></label>
            <span>共 {pagination.total} 位</span>
            <div>
              <button className="icon-button" type="button" disabled={loading || pagination.page <= 1} onClick={() => onPageChange(pagination.page - 1)} aria-label="上一页" title="上一页"><ChevronLeft size={16} /></button>
              <strong>{pagination.total ? `${pagination.page} / ${Math.max(1, pagination.total_pages)}` : "0 / 0"}</strong>
              <button className="icon-button" type="button" disabled={loading || !(pagination.has_next ?? pagination.page < pagination.total_pages)} onClick={() => onPageChange(pagination.page + 1)} aria-label="下一页" title="下一页"><ChevronRight size={16} /></button>
            </div>
          </div>
        </main>

        <aside className="position-summary-panel" aria-label="职位信息">
          <section className="position-summary-section">
            <header><h2>职位信息</h2>{!archived && <button className="text-action" type="button" disabled={busy} onClick={() => onEdit(position)}>编辑</button>}</header>
            <dl className="position-summary-list">
              <div><dt><Building2 size={14} />部门</dt><dd>{position.department || "未设置"}</dd></div>
              <div><dt><MapPin size={14} />工作地点</dt><dd>{position.location || "未设置"}</dd></div>
              <div><dt><UserRound size={14} />招聘负责人</dt><dd>{position.owner || "未分配"}</dd></div>
              <div><dt><UsersRound size={14} />计划人数</dt><dd>{position.headcount} 人</dd></div>
            </dl>
          </section>

          <section className="position-summary-section">
            <h2>标签</h2>
            {position.tags.length ? (
              <div className="position-tag-list">{position.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div>
            ) : <p className="position-summary-empty">暂无标签</p>}
          </section>

          <section className="position-summary-section">
            <h2>职位描述</h2>
            <p className="position-description">{position.description || "暂无职位描述"}</p>
          </section>

          <section className="position-summary-section position-record-section">
            <h2>记录信息</h2>
            <dl>
              <div><dt>创建时间</dt><dd>{formatDate(position.created_at)}</dd></div>
              <div><dt>最近更新</dt><dd>{formatDateTime(position.updated_at)}</dd></div>
              {position.archived_at && <div><dt>归档时间</dt><dd>{formatDateTime(position.archived_at)}</dd></div>}
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}
