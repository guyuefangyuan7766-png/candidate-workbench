import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  UserMinus,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { talentPoolApi, type TalentPoolDraft } from "../api";
import type { Candidate, Pagination, TalentPool } from "../types";
import { formatDateTime } from "../utils";
import { CandidatePickerDialog } from "./CandidatePickerDialog";
import { CandidateTable } from "./CandidateTable";

type ArchiveMode = "active" | "archived" | "all";

interface TalentPoolPageProps {
  onRefresh: () => Promise<void>;
  onOpenCandidate: (candidate: Candidate) => void;
  onEditCandidate: (candidate: Candidate) => void;
  onArchiveCandidate: (candidate: Candidate) => Promise<void> | void;
  onRestoreCandidate: (candidate: Candidate) => Promise<void> | void;
  onNotify: (message: string) => void;
}

const POOL_COLORS = ["#176b54", "#316b9b", "#9c6817", "#b75b45", "#6c5d8f", "#39737a"];
const PAGE_SIZES = [20, 50, 100] as const;
type PageSize = (typeof PAGE_SIZES)[number];
const EMPTY_PAGINATION: Pagination = { page: 1, page_size: 20, total: 0, total_pages: 0, has_next: false };

function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? `${fallback}：${error.message}` : fallback;
}

function PoolSelectionCheckbox({ checked, indeterminate = false, disabled = false, label, onChange }: { checked: boolean; indeterminate?: boolean; disabled?: boolean; label: string; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} className="candidate-checkbox" type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={onChange} />;
}

function EntityPagination({ pagination, pageSize, loading, label, onPageChange, onPageSizeChange }: {
  pagination: Pagination;
  pageSize: PageSize;
  loading?: boolean;
  label: string;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: PageSize) => void;
}) {
  const page = pagination.total ? pagination.page : 1;
  const pageCount = Math.max(1, pagination.total_pages);
  const hasNext = pagination.has_next ?? page < pageCount;
  return (
    <div className="entity-pagination pagination-compact">
      <label>每页<select value={pageSize} disabled={loading} onChange={(event) => onPageSizeChange(Number(event.target.value) as PageSize)}>{PAGE_SIZES.map((size) => <option value={size} key={size}>{size}</option>)}</select></label>
      <span>共 {pagination.total} {label}</span>
      <div>
        <button className="icon-button" type="button" disabled={loading || pagination.total === 0 || page <= 1} onClick={() => onPageChange(page - 1)} aria-label="上一页" title="上一页"><ChevronLeft size={16} /></button>
        <strong>{pagination.total ? `${page} / ${pageCount}` : "0 / 0"}</strong>
        <button className="icon-button" type="button" disabled={loading || pagination.total === 0 || !hasNext} onClick={() => onPageChange(page + 1)} aria-label="下一页" title="下一页"><ChevronRight size={16} /></button>
      </div>
    </div>
  );
}

export function TalentPoolPage({
  onRefresh,
  onOpenCandidate,
  onEditCandidate,
  onArchiveCandidate,
  onRestoreCandidate,
  onNotify,
}: TalentPoolPageProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [archiveMode, setArchiveMode] = useState<ArchiveMode>("active");
  const [pools, setPools] = useState<TalentPool[]>([]);
  const [poolPagination, setPoolPagination] = useState<Pagination>(EMPTY_PAGINATION);
  const [poolPage, setPoolPage] = useState(1);
  const [poolPageSize, setPoolPageSize] = useState<PageSize>(20);
  const [poolListLoading, setPoolListLoading] = useState(true);
  const [poolListError, setPoolListError] = useState("");
  const [poolRefreshVersion, setPoolRefreshVersion] = useState(0);
  const [activePoolId, setActivePoolId] = useState<string | null>(null);
  const [poolCandidates, setPoolCandidates] = useState<Candidate[]>([]);
  const [memberPagination, setMemberPagination] = useState<Pagination>(EMPTY_PAGINATION);
  const [memberPage, setMemberPage] = useState(1);
  const [memberPageSize, setMemberPageSize] = useState<PageSize>(20);
  const [memberRefreshVersion, setMemberRefreshVersion] = useState(0);
  const [poolLoading, setPoolLoading] = useState(false);
  const [poolError, setPoolError] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedPoolIds, setSelectedPoolIds] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const [editor, setEditor] = useState<"create" | "edit" | null>(null);
  const [editingPool, setEditingPool] = useState<TalentPool | null>(null);
  const [draft, setDraft] = useState<TalentPoolDraft>({ name: "", description: "", color: POOL_COLORS[0] });
  const [editorError, setEditorError] = useState("");
  const [archiveTargets, setArchiveTargets] = useState<TalentPool[] | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<TalentPool[] | null>(null);
  const deletedPoolIdsRef = useRef<Set<string>>(new Set());

  const visiblePools = pools;

  const activePool = pools.find((pool) => pool.id === activePoolId) ?? null;
  const selectedPoolKind = useMemo<"active" | "archived" | null>(() => {
    const firstId = selectedPoolIds.values().next().value as string | undefined;
    if (!firstId) return null;
    return pools.find((pool) => pool.id === firstId)?.archived_at ? "archived" : "active";
  }, [pools, selectedPoolIds]);
  const visiblePoolKinds = new Set(visiblePools.map((pool) => pool.archived_at ? "archived" : "active"));
  const headerPoolKind = selectedPoolKind
    ?? (visiblePoolKinds.size === 1 && visiblePools.length ? (visiblePools[0].archived_at ? "archived" : "active") : null);
  const selectablePoolIds = headerPoolKind
    ? visiblePools.filter((pool) => (pool.archived_at ? "archived" : "active") === headerPoolKind).map((pool) => pool.id)
    : [];
  const selectedVisiblePoolIds = selectablePoolIds.filter((id) => selectedPoolIds.has(id));
  const allVisiblePoolsSelected = selectablePoolIds.length > 0 && selectedVisiblePoolIds.length === selectablePoolIds.length;
  const someVisiblePoolsSelected = selectedVisiblePoolIds.length > 0 && !allVisiblePoolsSelected;
  const poolSelectionOverLimit = selectedPoolIds.size > 100;
  const deleteRelationCount = (deleteTargets ?? []).reduce((sum, pool) => sum + pool.candidate_count, 0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setPoolPage(1);
  }, [archiveMode, debouncedQuery, poolPageSize]);

  useEffect(() => {
    const controller = new AbortController();
    setPoolListLoading(true);
    setPoolListError("");
    setPools([]);
    void talentPoolApi.list({
      search: debouncedQuery || undefined,
      archived: archiveMode === "all" ? "include" : archiveMode === "archived" ? "only" : "exclude",
      sort: "updated_at",
      order: "desc",
      page: poolPage,
      page_size: poolPageSize,
    }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      const lastPage = Math.max(1, result.pagination.total_pages);
      if (poolPage > lastPage) {
        setPoolPage(lastPage);
        return;
      }
      setPools(result.items);
      setPoolPagination(result.pagination);
      setActivePoolId((current) => result.items.some((pool) => pool.id === current) ? current : result.items[0]?.id ?? null);
    }).catch((error) => {
      if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
      setPools([]);
      setPoolPagination(EMPTY_PAGINATION);
      setActivePoolId(null);
      setPoolListError(messageFrom(error, "人才库列表加载失败"));
    }).finally(() => {
      if (!controller.signal.aborted) setPoolListLoading(false);
    });
    return () => controller.abort();
  }, [archiveMode, debouncedQuery, poolPage, poolPageSize, poolRefreshVersion]);

  useEffect(() => {
    setMemberPage(1);
    setSelectedIds(new Set());
    setPoolCandidates([]);
    setMemberPagination(EMPTY_PAGINATION);
  }, [activePoolId]);

  useEffect(() => {
    if (!activePoolId || deletedPoolIdsRef.current.has(activePoolId)) {
      setPoolCandidates([]);
      setMemberPagination(EMPTY_PAGINATION);
      return;
    }
    const controller = new AbortController();
    setPoolLoading(true);
    setPoolError("");
    setPoolCandidates([]);
    void talentPoolApi.candidates(activePoolId, {
      archived: "include",
      sort: "updated_at",
      order: "desc",
      page: memberPage,
      page_size: memberPageSize,
    }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      const lastPage = Math.max(1, result.pagination.total_pages);
      if (memberPage > lastPage) {
        setMemberPage(lastPage);
        return;
      }
      setPoolCandidates(result.items);
      setMemberPagination(result.pagination);
    }).catch((error) => {
      if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
      setPoolCandidates([]);
      setMemberPagination(EMPTY_PAGINATION);
      setPoolError(messageFrom(error, "人才库成员加载失败"));
    }).finally(() => {
      if (!controller.signal.aborted) setPoolLoading(false);
    });
    return () => controller.abort();
  }, [activePoolId, memberPage, memberPageSize, memberRefreshVersion]);

  useEffect(() => {
    setSelectedPoolIds(new Set());
  }, [archiveMode, debouncedQuery, poolPage, poolPageSize]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [memberPage, memberPageSize]);

  const refreshPools = useCallback(() => setPoolRefreshVersion((value) => value + 1), []);
  const refreshMembers = useCallback(() => setMemberRefreshVersion((value) => value + 1), []);

  function togglePoolSelection(pool: TalentPool) {
    const kind = pool.archived_at ? "archived" : "active";
    if (selectedPoolKind && selectedPoolKind !== kind) {
      onNotify("使用中与已归档人才库不能混合选择，请先取消当前选择");
      return;
    }
    setSelectedPoolIds((current) => {
      const next = new Set(current);
      next.has(pool.id) ? next.delete(pool.id) : next.add(pool.id);
      return next;
    });
  }

  function toggleAllPools(selected: boolean) {
    setSelectedPoolIds(selected ? new Set(selectablePoolIds) : new Set());
  }

  function selectedPoolsFor(kind: "active" | "archived") {
    const targets = [...selectedPoolIds].map((id) => pools.find((pool) => pool.id === id));
    const invalid = targets.some((pool) => !pool || (pool.archived_at ? "archived" : "active") !== kind);
    if (invalid || targets.length !== selectedPoolIds.size) {
      setSelectedPoolIds(new Set());
      refreshPools();
      void onRefresh();
      onNotify("所选人才库状态已变化，请刷新后重新选择");
      return null;
    }
    return targets as TalentPool[];
  }

  function requestArchiveSelectedPools() {
    const targets = selectedPoolsFor("active");
    if (targets?.length) setArchiveTargets(targets);
  }

  function requestDeleteSelectedPools() {
    const targets = selectedPoolsFor("archived");
    if (targets?.length) setDeleteTargets(targets);
  }

  function openEditor(mode: "create" | "edit", pool?: TalentPool) {
    setEditor(mode);
    setEditingPool(pool ?? null);
    setDraft(pool
      ? { name: pool.name, description: pool.description, color: pool.color }
      : { name: "", description: "", color: POOL_COLORS[0] });
    setEditorError("");
  }

  async function savePool(event: FormEvent) {
    event.preventDefault();
    const name = draft.name.trim();
    if (!name) return setEditorError("请填写人才库名称");
    setOperationBusy(true);
    setEditorError("");
    try {
      const saved = editor === "edit" && editingPool
        ? await talentPoolApi.update(editingPool.id, { ...draft, name })
        : await talentPoolApi.create({ ...draft, name });
      await onRefresh();
      setPoolPage(1);
      refreshPools();
      setActivePoolId(saved.id);
      setEditor(null);
      onNotify(editor === "edit" ? "人才库信息已更新" : "人才库已创建");
    } catch (error) {
      setEditorError(messageFrom(error, "人才库保存失败"));
    } finally {
      setOperationBusy(false);
    }
  }

  async function archivePools(targets: TalentPool[]) {
    if (!targets.length) return;
    if (targets.length > 100) {
      onNotify("单次最多归档 100 个人才库，请缩小选择范围");
      return;
    }
    setOperationBusy(true);
    try {
      let updatedCount = 1;
      if (targets.length === 1) {
        await talentPoolApi.archive(targets[0].id, targets[0].updated_at);
      } else {
        updatedCount = (await talentPoolApi.archiveBatch(targets.map((pool) => ({ id: pool.id, expected_updated_at: pool.updated_at })))).updated_count;
      }
      if (targets.some((pool) => pool.id === activePoolId)) setActivePoolId(null);
      await onRefresh();
      refreshPools();
      setArchiveTargets(null);
      setSelectedPoolIds(new Set());
      onNotify(`已归档 ${updatedCount} 个人才库，候选人档案未受影响`);
    } catch (error) {
      onNotify(messageFrom(error, "人才库归档失败"));
    } finally {
      setOperationBusy(false);
    }
  }

  async function restorePool(pool: TalentPool) {
    setOperationBusy(true);
    try {
      await talentPoolApi.restore(pool.id, pool.updated_at);
      if (pool.id === activePoolId) setActivePoolId(null);
      await onRefresh();
      refreshPools();
      setSelectedPoolIds(new Set());
      onNotify("人才库已恢复");
    } catch (error) {
      onNotify(messageFrom(error, "人才库恢复失败"));
    } finally {
      setOperationBusy(false);
    }
  }

  async function restoreSelectedPools() {
    const targets = selectedPoolsFor("archived");
    if (!targets?.length) return;
    if (targets.length > 100) {
      onNotify("单次最多恢复 100 个人才库，请缩小选择范围");
      return;
    }
    setOperationBusy(true);
    try {
      const result = await talentPoolApi.restoreBatch(targets.map((pool) => ({ id: pool.id, expected_updated_at: pool.updated_at })));
      if (targets.some((pool) => pool.id === activePoolId)) setActivePoolId(null);
      await onRefresh();
      refreshPools();
      setSelectedPoolIds(new Set());
      onNotify(`已恢复 ${result.updated_count} 个人才库`);
    } catch (error) {
      onNotify(messageFrom(error, "人才库批量恢复失败"));
    } finally {
      setOperationBusy(false);
    }
  }

  async function permanentlyDeletePools(targets: TalentPool[]) {
    if (!targets.length) return;
    if (targets.length > 100) {
      onNotify("单次最多永久删除 100 个人才库，请缩小选择范围");
      return;
    }
    setOperationBusy(true);
    try {
      const result = targets.length === 1
        ? await talentPoolApi.permanentDelete(targets[0].id, targets[0].updated_at)
        : await talentPoolApi.permanentDeleteBatch(targets.map((pool) => ({ id: pool.id, expected_updated_at: pool.updated_at })));
      targets.forEach((pool) => deletedPoolIdsRef.current.add(pool.id));
      setDeleteTargets(null);
      setSelectedPoolIds(new Set());
      if (targets.some((pool) => pool.id === activePoolId)) setActivePoolId(null);
      await onRefresh();
      refreshPools();
      onNotify(`已永久删除 ${result.deleted_count} 个人才库并解除 ${result.relation_count} 条分组关系，候选人档案均保留`);
    } catch (error) {
      onNotify(messageFrom(error, "人才库永久删除失败"));
    } finally {
      setOperationBusy(false);
    }
  }

  async function addCandidates(candidateIds: string[]) {
    if (!activePool) return;
    setOperationBusy(true);
    try {
      const result = await talentPoolApi.linkCandidates(activePool.id, candidateIds);
      await onRefresh();
      refreshPools();
      refreshMembers();
      setPickerOpen(false);
      onNotify(`已加入 ${result.linked_count} 位候选人${result.already_linked_count ? `，${result.already_linked_count} 位原已在库` : ""}`);
    } catch (error) {
      onNotify(messageFrom(error, "加入人才库失败"));
    } finally {
      setOperationBusy(false);
    }
  }

  async function removeCandidates() {
    if (!activePool || !selectedIds.size) return;
    setOperationBusy(true);
    try {
      const result = await talentPoolApi.unlinkCandidates(activePool.id, [...selectedIds]);
      await onRefresh();
      refreshPools();
      refreshMembers();
      setSelectedIds(new Set());
      onNotify(`已从人才库移出 ${result.unlinked_count} 位候选人，候选人档案仍保留`);
    } catch (error) {
      onNotify(messageFrom(error, "移出人才库失败"));
    } finally {
      setOperationBusy(false);
    }
  }

  if (poolListLoading && !pools.length) {
    return <section className="talent-pool-page" aria-busy="true"><header className="page-heading"><div><p className="eyebrow">人才分组</p><h1>人才库分组</h1><p className="page-description">按长期人才价值整理候选人</p></div></header><div className="talent-pool-layout talent-pool-skeleton"><div className="talent-pool-index skeleton-block" /><div><div className="page-title-skeleton skeleton-block" /><div className="list-skeleton">{[0, 1, 2, 3, 4].map((item) => <div className="skeleton-row" key={item}><span className="skeleton-avatar skeleton-block" /><span className="skeleton-line skeleton-block" /></div>)}</div></div></div></section>;
  }

  return (
    <section className="talent-pool-page">
      <header className="page-heading">
        <div><p className="eyebrow">人才分组</p><h1>人才库分组</h1><p className="page-description">按长期人才价值整理候选人，不改变候选人档案或职位关联</p></div>
        <button className="button primary-button" type="button" onClick={() => openEditor("create")}><Plus size={17} />新建人才库</button>
      </header>

      {selectedPoolIds.size > 0 && (
        <div className="bulk-action-bar talent-pool-group-bulk-bar">
          <span><Check size={16} />已选择 {selectedPoolIds.size} 个{selectedPoolKind === "archived" ? "已归档" : "使用中"}人才库{poolSelectionOverLimit ? "，单批上限为 100" : ""}</span>
          <div>
            <button className="button secondary-button" type="button" onClick={() => setSelectedPoolIds(new Set())} disabled={operationBusy}>取消选择</button>
            {selectedPoolKind === "archived" ? (
              <>
                <button className="button secondary-button" type="button" onClick={() => void restoreSelectedPools()} disabled={operationBusy || poolSelectionOverLimit}><RotateCcw size={16} />批量恢复</button>
                <button className="button danger-button" type="button" onClick={requestDeleteSelectedPools} disabled={operationBusy || poolSelectionOverLimit}><Trash2 size={16} />批量永久删除</button>
              </>
            ) : (
              <button className="button danger-quiet-button" type="button" onClick={requestArchiveSelectedPools} disabled={operationBusy || poolSelectionOverLimit}><Archive size={16} />批量归档</button>
            )}
          </div>
        </div>
      )}

      <div className="talent-pool-layout">
        <aside className="talent-pool-index" aria-label="人才库列表">
          <div className="talent-pool-index-toolbar">
            <label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索人才库" />{query && <button type="button" onClick={() => setQuery("")} aria-label="清除搜索"><X size={14} /></button>}</label>
            <select value={archiveMode} onChange={(event) => setArchiveMode(event.target.value as ArchiveMode)} aria-label="人才库归档状态">
              <option value="active">使用中</option><option value="archived">已归档</option><option value="all">全部</option>
            </select>
          </div>
          <div className="talent-pool-selection-toolbar">
            <PoolSelectionCheckbox
              checked={allVisiblePoolsSelected}
              indeterminate={someVisiblePoolsSelected}
              disabled={!selectablePoolIds.length}
              label={`选择当前视图全部${headerPoolKind === "archived" ? "已归档" : "使用中"}人才库`}
              onChange={() => toggleAllPools(!allVisiblePoolsSelected)}
            />
            <span>全选当前视图</span>
            {selectedPoolIds.size > 0 && <button type="button" onClick={() => setSelectedPoolIds(new Set())}>取消</button>}
          </div>
          <div className="talent-pool-list" role="region" aria-label="人才库横向列表" tabIndex={0}>
            {visiblePools.map((pool) => {
              const poolKind = pool.archived_at ? "archived" : "active";
              const selected = selectedPoolIds.has(pool.id);
              const selectable = !selectedPoolKind || selectedPoolKind === poolKind;
              return (
                <div className={`talent-pool-list-item${activePoolId === pool.id ? " active" : ""}${pool.archived_at ? " is-archived" : ""}${selected ? " is-selected" : ""}`} key={pool.id}>
                  <PoolSelectionCheckbox checked={selected} disabled={!selectable || operationBusy} label={`选择人才库 ${pool.name}`} onChange={() => togglePoolSelection(pool)} />
                  <button className="talent-pool-list-open" type="button" onClick={() => setActivePoolId(pool.id)}>
                    <span className="pool-color" style={{ backgroundColor: pool.color }} />
                    <span><strong>{pool.name}</strong><small>{pool.candidate_count} 位候选人</small></span>
                    <span className="pool-updated">{formatDateTime(pool.updated_at)}</span>
                  </button>
                </div>
              );
            })}
            {!poolListLoading && !visiblePools.length && <div className="talent-pool-index-empty"><FolderKanban size={22} /><span>{query ? "没有匹配的人才库" : "暂无人才库"}</span></div>}
          </div>
          {poolListError && <div className="workspace-error talent-pool-list-error" role="alert"><span>{poolListError}</span><button className="button secondary-button" type="button" onClick={refreshPools}>重试</button></div>}
          <EntityPagination pagination={poolPagination} pageSize={poolPageSize} loading={poolListLoading} label="个分组" onPageChange={setPoolPage} onPageSizeChange={(pageSize) => { setPoolPageSize(pageSize); setPoolPage(1); }} />
        </aside>

        <div className="talent-pool-workspace">
          {activePool ? (
            <>
              <header className="talent-pool-workspace-header">
                <div className="talent-pool-title"><span className="pool-color pool-color-large" style={{ backgroundColor: activePool.color }} /><div><div><h2>{activePool.name}</h2>{activePool.archived_at && <span className="archive-badge">已归档</span>}</div><p>{activePool.description || "暂无说明"}</p></div></div>
                <div className="talent-pool-actions">
                  {!activePool.archived_at && <button className="button secondary-button" type="button" onClick={() => setPickerOpen(true)}><UserPlus size={16} />加入候选人</button>}
                  <button className="icon-button" type="button" onClick={() => openEditor("edit", activePool)} aria-label="编辑人才库" title="编辑人才库"><Pencil size={16} /></button>
                  {activePool.archived_at
                    ? <><button className="icon-button" type="button" onClick={() => void restorePool(activePool)} disabled={operationBusy} aria-label="恢复人才库" title="恢复"><RotateCcw size={16} /></button><button className="icon-button danger-icon-button" type="button" onClick={() => setDeleteTargets([activePool])} disabled={operationBusy} aria-label="永久删除人才库" title="永久删除"><Trash2 size={16} /></button></>
                    : <button className="icon-button" type="button" onClick={() => setArchiveTargets([activePool])} aria-label="归档人才库" title="归档"><Archive size={16} /></button>}
                </div>
              </header>

              <div className="talent-pool-member-summary"><span><UsersRound size={15} />{memberPagination.total} 位成员</span><small>移出分组不会删除候选人档案</small></div>
              {selectedIds.size > 0 && (
                <div className="bulk-action-bar"><span>已选择 {selectedIds.size} 位候选人</span><div><button className="button secondary-button" type="button" onClick={() => setSelectedIds(new Set())}>取消选择</button><button className="button danger-quiet-button" type="button" onClick={() => void removeCandidates()} disabled={operationBusy}><UserMinus size={16} />移出当前人才库</button></div></div>
              )}
              {poolError ? <div className="workspace-error" role="alert"><span>{poolError}</span><button className="button secondary-button" type="button" onClick={refreshMembers}>重新加载</button></div> : (
                <CandidateTable
                  candidates={poolCandidates}
                  archived={false}
                  selectedIds={selectedIds}
                  onToggle={(id) => setSelectedIds((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; })}
                  onToggleAll={(ids, selected) => setSelectedIds(selected ? new Set(ids) : new Set())}
                  onOpen={onOpenCandidate}
                  onEdit={onEditCandidate}
                  onArchive={(candidate) => { Promise.resolve(onArchiveCandidate(candidate)).finally(() => { refreshMembers(); refreshPools(); }); }}
                  onRestore={(candidate) => { Promise.resolve(onRestoreCandidate(candidate)).finally(() => { refreshMembers(); refreshPools(); }); }}
                />
              )}
              {poolLoading && <div className="talent-pool-loading" role="status">正在加载人才库成员...</div>}
              <EntityPagination pagination={memberPagination} pageSize={memberPageSize} loading={poolLoading} label="位成员" onPageChange={setMemberPage} onPageSizeChange={(pageSize) => { setMemberPageSize(pageSize); setMemberPage(1); }} />
            </>
          ) : (
            <div className="talent-pool-empty"><span><FolderKanban size={28} /></span><h2>建立第一个人才库</h2><p>用于沉淀高潜人才、专业方向或长期关注人群。</p><button className="button primary-button" type="button" onClick={() => openEditor("create")}><Plus size={16} />新建人才库</button></div>
          )}
        </div>
      </div>

      <CandidatePickerDialog
        open={pickerOpen}
        excludePoolId={activePool?.id}
        busy={operationBusy}
        eyebrow="人才库成员"
        title={`加入“${activePool?.name ?? "人才库"}”`}
        helperText="仅建立人才库分组关系，不改变职位和候选人档案"
        confirmLabel="加入"
        onClose={() => !operationBusy && setPickerOpen(false)}
        onConfirm={(ids) => void addCandidates(ids)}
      />

      {editor && (
        <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !operationBusy && setEditor(null)}>
          <form className="modal compact-modal talent-pool-editor" onSubmit={(event) => void savePool(event)}>
            <header className="modal-header"><div><p className="drawer-kicker">人才分组</p><h2>{editor === "edit" ? "编辑人才库" : "新建人才库"}</h2></div><button className="icon-button" type="button" onClick={() => setEditor(null)} disabled={operationBusy} aria-label="关闭"><X size={19} /></button></header>
            <div className="modal-body talent-pool-editor-body">
              <label className="field required-field"><span>名称</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} maxLength={80} autoFocus /></label>
              <label className="field"><span>说明</span><textarea value={draft.description ?? ""} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} maxLength={500} rows={4} placeholder="说明这组人才的用途或入库标准" /></label>
              <fieldset className="pool-color-field"><legend>标识颜色</legend><div>{POOL_COLORS.map((color) => <button className={draft.color === color ? "active" : ""} type="button" key={color} style={{ backgroundColor: color }} onClick={() => setDraft((current) => ({ ...current, color }))} aria-label={`选择颜色 ${color}`} />)}</div></fieldset>
              {editorError && <p className="form-error" role="alert">{editorError}</p>}
            </div>
            <footer className="modal-footer"><button className="button secondary-button" type="button" onClick={() => setEditor(null)} disabled={operationBusy}>取消</button><button className="button primary-button" type="submit" disabled={operationBusy}>{operationBusy ? "正在保存..." : "保存"}</button></footer>
          </form>
        </div>
      )}

      {archiveTargets && (
        <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !operationBusy && setArchiveTargets(null)}>
          <div className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-label="归档人才库">
            <header className="modal-header"><div><p className="drawer-kicker">操作确认</p><h2>归档 {archiveTargets.length} 个人才库</h2></div><button className="icon-button" type="button" onClick={() => setArchiveTargets(null)} disabled={operationBusy} aria-label="关闭"><X size={19} /></button></header>
            <div className="modal-body confirm-body"><span className="confirm-icon danger"><Archive size={22} /></span><p>选中的人才库将从默认列表隐藏，可在“已归档”视图中恢复。共 {archiveTargets.reduce((sum, pool) => sum + pool.candidate_count, 0)} 条候选人分组关系会保留，不会删除或归档候选人。</p></div>
            <footer className="modal-footer"><button className="button secondary-button" type="button" onClick={() => setArchiveTargets(null)} disabled={operationBusy}>取消</button><button className="button danger-button" type="button" onClick={() => void archivePools(archiveTargets)} disabled={operationBusy}>{operationBusy ? "正在处理..." : "确认归档"}</button></footer>
          </div>
        </div>
      )}

      {deleteTargets && (
        <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !operationBusy && setDeleteTargets(null)}>
          <div className="modal confirm-modal talent-pool-delete-modal" role="alertdialog" aria-modal="true" aria-label="永久删除人才库">
            <header className="modal-header"><div><p className="drawer-kicker danger-kicker">不可恢复操作</p><h2>永久删除 {deleteTargets.length} 个人才库</h2></div><button className="icon-button" type="button" onClick={() => setDeleteTargets(null)} disabled={operationBusy} aria-label="关闭"><X size={19} /></button></header>
            <div className="modal-body confirm-body talent-pool-delete-body">
              <span className="confirm-icon danger"><Trash2 size={22} /></span>
              <p>将永久删除 {deleteTargets.length} 个已归档人才库，最多涉及 {deleteRelationCount} 位候选人，并解除 {deleteRelationCount} 条分组关系。人才库删除后无法恢复。</p>
              <div className="talent-pool-delete-boundary"><strong>候选人档案不会被删除</strong><span>候选人、职位、附件、备注、活动和履历均保持完整。</span></div>
            </div>
            <footer className="modal-footer"><button className="button secondary-button" type="button" onClick={() => setDeleteTargets(null)} disabled={operationBusy}>取消</button><button className="button danger-button" type="button" onClick={() => void permanentlyDeletePools(deleteTargets)} disabled={operationBusy}>{operationBusy ? "正在删除..." : "确认永久删除"}</button></footer>
          </div>
        </div>
      )}
    </section>
  );
}
