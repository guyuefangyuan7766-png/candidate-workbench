import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  Folder,
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
import { candidateApi, talentPoolApi, type TalentPoolDraft } from "../api";
import type { Candidate, CandidateFacets, Pagination, TalentPool } from "../types";
import { formatDate, formatDateTime } from "../utils";
import { CandidatePickerDialog } from "./CandidatePickerDialog";
import { TwAvatar } from "../views/TwAvatar";
import { TwSelect } from "../views/TwSelect";

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
const EMPTY_FACETS: CandidateFacets = { sources: [], owners: [], tags: [], education: [], schools: [], genders: [], job_seeking_statuses: [], totals: { total: 0, active: 0, archived: 0 } };
type MemberFilters = { education: string; tag: string; source: string; owner: string; school: string };
const EMPTY_MEMBER_FILTERS: MemberFilters = { education: "all", tag: "all", source: "all", owner: "all", school: "all" };

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
    <div className="tw-mini-pagination">
      <span>共 {pagination.total} {label}</span>
      <div className="tw-pages">
        <button className="tw-icon-plain" type="button" disabled={loading || pagination.total === 0 || page <= 1} onClick={() => onPageChange(page - 1)} aria-label="上一页" title="上一页"><ChevronLeft size={15} /></button>
        <span className="tw-mini-page">{pagination.total ? page + " / " + pageCount : "0 / 0"}</span>
        <button className="tw-icon-plain" type="button" disabled={loading || pagination.total === 0 || !hasNext} onClick={() => onPageChange(page + 1)} aria-label="下一页" title="下一页"><ChevronRight size={15} /></button>
      </div>
      <label className="tw-page-size">每页
        <select value={pageSize} disabled={loading} onChange={(event) => onPageSizeChange(Number(event.target.value) as PageSize)}>
          {PAGE_SIZES.map((size) => <option value={size} key={size}>{size}</option>)}
        </select>
      </label>
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
  const [archiveMode, setArchiveMode] = useState<ArchiveMode>("all");
  const [pools, setPools] = useState<TalentPool[]>([]);
  const [poolPagination, setPoolPagination] = useState<Pagination>(EMPTY_PAGINATION);
  const [poolPage, setPoolPage] = useState(1);
  const [poolPageSize, setPoolPageSize] = useState<PageSize>(50);
  const [poolListLoading, setPoolListLoading] = useState(true);
  const [poolListError, setPoolListError] = useState("");
  const [poolRefreshVersion, setPoolRefreshVersion] = useState(0);
  const [activePoolId, setActivePoolId] = useState<string | null>(null);
  const [poolCandidates, setPoolCandidates] = useState<Candidate[]>([]);
  const [memberPagination, setMemberPagination] = useState<Pagination>(EMPTY_PAGINATION);
  const [memberPage, setMemberPage] = useState(1);
  const [memberPageSize, setMemberPageSize] = useState<PageSize>(20);
  const [memberQuery, setMemberQuery] = useState("");
  const [debouncedMemberQuery, setDebouncedMemberQuery] = useState("");
  const [memberFilters, setMemberFilters] = useState<MemberFilters>(EMPTY_MEMBER_FILTERS);
  const [memberFacets, setMemberFacets] = useState<CandidateFacets>(EMPTY_FACETS);
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
  const visibleActivePoolIds = visiblePools.filter((pool) => !pool.archived_at).map((pool) => pool.id);
  const visibleArchivedPoolIds = visiblePools.filter((pool) => pool.archived_at).map((pool) => pool.id);
  const selectedVisibleActivePoolIds = visibleActivePoolIds.filter((id) => selectedPoolIds.has(id));
  const selectedVisibleArchivedPoolIds = visibleArchivedPoolIds.filter((id) => selectedPoolIds.has(id));
  const allVisibleActivePoolsSelected = visibleActivePoolIds.length > 0 && selectedVisibleActivePoolIds.length === visibleActivePoolIds.length;
  const allVisibleArchivedPoolsSelected = visibleArchivedPoolIds.length > 0 && selectedVisibleArchivedPoolIds.length === visibleArchivedPoolIds.length;
  const someVisibleActivePoolsSelected = selectedVisibleActivePoolIds.length > 0 && !allVisibleActivePoolsSelected;
  const someVisibleArchivedPoolsSelected = selectedVisibleArchivedPoolIds.length > 0 && !allVisibleArchivedPoolsSelected;
  const poolSelectionOverLimit = selectedPoolIds.size > 100;
  const deleteRelationCount = (deleteTargets ?? []).reduce((sum, pool) => sum + pool.candidate_count, 0);
  const appliedMemberFilterCount = Object.values(memberFilters).filter((value) => value !== "all").length;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setPoolPage(1);
  }, [archiveMode, debouncedQuery, poolPageSize]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedMemberQuery(memberQuery.trim());
      setMemberPage(1);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [memberQuery]);

  useEffect(() => {
    const controller = new AbortController();
    void candidateApi.facets({ archived: "include" }, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setMemberFacets(result); })
      .catch(() => { if (!controller.signal.aborted) setMemberFacets(EMPTY_FACETS); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setMemberPage(1);
  }, [memberFilters]);

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
      search: debouncedMemberQuery || undefined,
      education: memberFilters.education === "all" ? undefined : memberFilters.education,
      tag: memberFilters.tag === "all" ? undefined : memberFilters.tag,
      source: memberFilters.source === "all" ? undefined : memberFilters.source,
      owner: memberFilters.owner === "all" ? undefined : memberFilters.owner,
      school: memberFilters.school === "all" ? undefined : memberFilters.school,
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
  }, [activePoolId, memberPage, memberPageSize, memberRefreshVersion, debouncedMemberQuery, memberFilters]);

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

  function toggleAllPools(kind: "active" | "archived", selected: boolean) {
    const visibleIds = kind === "active" ? visibleActivePoolIds : visibleArchivedPoolIds;
    setSelectedPoolIds((current) => {
      if (selected) return new Set(visibleIds);
      const next = new Set(current);
      visibleIds.forEach((id) => next.delete(id));
      return next;
    });
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
    <section className="tw-page" aria-label="人才库分组">
      {selectedPoolIds.size > 0 && (
        <div className="tw-bulk" role="region" aria-label="批量操作">
          <span className="tw-bulk-info">
            <Check size={16} />已选择 {selectedPoolIds.size} 个{selectedPoolKind === "archived" ? "已归档" : "使用中"}人才库{poolSelectionOverLimit ? "，单批上限为 100" : ""}
          </span>
          <div className="tw-bulk-actions">
            <button className="tw-btn tw-btn-sm" type="button" onClick={() => setSelectedPoolIds(new Set())} disabled={operationBusy}>取消选择</button>
            {selectedPoolKind === "archived" ? (
              <>
                <button className="tw-btn tw-btn-sm" type="button" onClick={() => void restoreSelectedPools()} disabled={operationBusy || poolSelectionOverLimit}><RotateCcw size={15} />批量恢复</button>
                <button className="tw-btn tw-btn-sm tw-btn-danger" type="button" onClick={requestDeleteSelectedPools} disabled={operationBusy || poolSelectionOverLimit}><Trash2 size={15} />批量永久删除</button>
              </>
            ) : (
              <button className="tw-btn tw-btn-sm tw-btn-quiet-danger" type="button" onClick={requestArchiveSelectedPools} disabled={operationBusy || poolSelectionOverLimit}><Archive size={15} />批量归档</button>
            )}
          </div>
        </div>
      )}

      <div className="tw-split">
        <aside className="tw-subnav" aria-label="人才库列表">
          <div className="tw-subnav-head">
            <h2>人才库分组</h2>
            <button className="tw-icon-plain" type="button" onClick={() => openEditor("create")} aria-label="新建分组" title="新建分组"><Plus size={16} /></button>
          </div>
          <label className="tw-subnav-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索分组" aria-label="搜索人才库分组" />
            {query && <button type="button" onClick={() => setQuery("")} aria-label="清除搜索"><X size={14} /></button>}
          </label>
          <div className="tw-subnav-tabs" role="group" aria-label="人才库归档状态">
            {[["all", "全部"], ["active", "使用中"], ["archived", "已归档"]].map(([value, label]) => (
              <button className={archiveMode === value ? "active" : ""} type="button" key={value} aria-pressed={archiveMode === value} onClick={() => setArchiveMode(value as ArchiveMode)}>{label}</button>
            ))}
          </div>
          <div className="tw-subnav-select">
            {(archiveMode === "all" || archiveMode === "active") && <label className="tw-check"><PoolSelectionCheckbox
              checked={allVisibleActivePoolsSelected}
              indeterminate={someVisibleActivePoolsSelected}
              disabled={!visibleActivePoolIds.length || selectedPoolKind === "archived" || operationBusy}
              label="选择当前页全部使用中人才库"
              onChange={() => toggleAllPools("active", !allVisibleActivePoolsSelected)}
            /><span>全选使用中</span></label>}
            {(archiveMode === "all" || archiveMode === "archived") && <label className="tw-check"><PoolSelectionCheckbox
              checked={allVisibleArchivedPoolsSelected}
              indeterminate={someVisibleArchivedPoolsSelected}
              disabled={!visibleArchivedPoolIds.length || selectedPoolKind === "active" || operationBusy}
              label="选择当前页全部已归档人才库"
              onChange={() => toggleAllPools("archived", !allVisibleArchivedPoolsSelected)}
            /><span>全选已归档</span></label>}
            {selectedPoolIds.size > 0 && <button className="tw-applied-clear" type="button" onClick={() => setSelectedPoolIds(new Set())}>取消选择</button>}
          </div>
          <div className="tw-subnav-list" role="region" aria-label="人才库分组列表" tabIndex={0}>
            {visiblePools.map((pool) => {
              const poolKind = pool.archived_at ? "archived" : "active";
              const selected = selectedPoolIds.has(pool.id);
              const selectable = !selectedPoolKind || selectedPoolKind === poolKind;
              return (
                <div className={"tw-pool-item-wrap" + (selected ? " is-selected" : "")} key={pool.id}>
                  <PoolSelectionCheckbox checked={selected} disabled={!selectable || operationBusy} label={"选择人才库 " + pool.name} onChange={() => togglePoolSelection(pool)} />
                  <button
                    className={"tw-pool-item" + (activePoolId === pool.id ? " active" : "") + (pool.archived_at ? " is-archived" : "")}
                    type="button"
                    onClick={() => setActivePoolId(pool.id)}
                    aria-current={activePoolId === pool.id ? "true" : undefined}
                    title={[pool.name, pool.description?.trim()].filter(Boolean).join(" · ")}
                  >
                    <span className="tw-pool-folder"><Folder size={20} strokeWidth={1.8} /></span>
                    <span className="tw-pool-item-body">
                      <strong title={pool.name}>{pool.name}</strong>
                    </span>
                    {pool.archived_at && <span className="tw-pool-tag">已归档</span>}
                    <span className="tw-pool-count">{pool.candidate_count}</span>
                  </button>
                </div>
              );
            })}
            {!poolListLoading && !visiblePools.length && <p className="tw-empty-inline" style={{ padding: "12px" }}>{query ? "没有匹配的人才库" : "暂无人才库"}</p>}
          </div>
          {poolListError && (
            <div className="tw-alert" style={{ margin: "0 12px 10px" }} role="alert">
              <span>{poolListError}</span>
              <button className="tw-btn tw-btn-sm" type="button" onClick={refreshPools}>重试</button>
            </div>
          )}
          <div className="tw-subnav-foot">
            <EntityPagination pagination={poolPagination} pageSize={poolPageSize} loading={poolListLoading} label="个分组" onPageChange={setPoolPage} onPageSizeChange={(pageSize) => { setPoolPageSize(pageSize); setPoolPage(1); }} />
          </div>
        </aside>

        <div className="tw-main-pane">
          {activePool ? (
            <>
              <header className="tw-pane-head">
                <div className="tw-pane-title">
                  <h1>{activePool.name}</h1>
                  {activePool.archived_at && <span className="tw-status tw-status-archived">已归档</span>}
                  <p className="tw-sub">共 {memberPagination.total} 位候选人</p>
                  <p className="tw-sub">{activePool.description || "暂无说明"}</p>
                </div>
                <div className="tw-pane-actions">
                  {!activePool.archived_at && <button className="tw-btn tw-btn-primary" type="button" onClick={() => setPickerOpen(true)}><UserPlus size={16} />加入候选人</button>}
                  <button className="tw-btn" type="button" onClick={() => openEditor("edit", activePool)}><Pencil size={16} />编辑分组</button>
                  {activePool.archived_at
                    ? <>
                        <button className="tw-btn" type="button" onClick={() => void restorePool(activePool)} disabled={operationBusy} aria-label="恢复人才库" title="恢复"><RotateCcw size={16} />恢复分组</button>
                        <button className="tw-btn tw-btn-danger" type="button" onClick={() => setDeleteTargets([activePool])} disabled={operationBusy} aria-label="永久删除人才库" title="永久删除"><Trash2 size={16} />永久删除</button>
                      </>
                    : <button className="tw-btn" type="button" onClick={() => setArchiveTargets([activePool])}><Archive size={16} />归档分组</button>}
                </div>
              </header>

              <div className="tw-toolbar tw-toolbar-tight">
                <label className="tw-search">
                  <Search size={17} />
                  <input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="搜索候选人姓名、公司、技能等" aria-label="搜索人才库成员" />
                  {memberQuery && <button type="button" onClick={() => setMemberQuery("")} aria-label="清除成员搜索"><X size={15} /></button>}
                </label>
              </div>

              <div className="tw-chips" aria-label="成员筛选">
                <TwSelect
                  label="学历"
                  value={memberFilters.education}
                  onChange={(value) => setMemberFilters((current) => ({ ...current, education: value }))}
                  options={[{ value: "all", label: "全部学历" }, ...memberFacets.education.map((item) => ({ value: item, label: item }))]}
                />
                <TwSelect
                  label="技能标签"
                  value={memberFilters.tag}
                  onChange={(value) => setMemberFilters((current) => ({ ...current, tag: value }))}
                  options={[{ value: "all", label: "全部技能标签" }, ...memberFacets.tags.map((item) => ({ value: item, label: item }))]}
                />
                <TwSelect
                  label="来源"
                  value={memberFilters.source}
                  onChange={(value) => setMemberFilters((current) => ({ ...current, source: value }))}
                  options={[{ value: "all", label: "全部来源" }, ...memberFacets.sources.map((item) => ({ value: item, label: item }))]}
                />
                <TwSelect
                  label="负责人"
                  value={memberFilters.owner}
                  onChange={(value) => setMemberFilters((current) => ({ ...current, owner: value }))}
                  options={[{ value: "all", label: "全部负责人" }, ...memberFacets.owners.map((item) => ({ value: item, label: item }))]}
                />
                <TwSelect
                  label="学校"
                  value={memberFilters.school}
                  onChange={(value) => setMemberFilters((current) => ({ ...current, school: value }))}
                  options={[{ value: "all", label: "全部学校" }, ...memberFacets.schools.map((item) => ({ value: item, label: item }))]}
                />
                {appliedMemberFilterCount > 0 && (
                  <>
                    <span className="tw-chips-spacer" />
                    <button className="tw-chips-clear" type="button" onClick={() => setMemberFilters(EMPTY_MEMBER_FILTERS)}>清空筛选</button>
                  </>
                )}
              </div>

              {selectedIds.size > 0 && (
                <div className="tw-bulk" role="region" aria-label="成员批量操作">
                  <span className="tw-bulk-info"><Check size={16} />已选择 {selectedIds.size} 位候选人</span>
                  <div className="tw-bulk-actions">
                    <button className="tw-btn tw-btn-sm" type="button" onClick={() => setSelectedIds(new Set())}>取消选择</button>
                    <button className="tw-btn tw-btn-sm tw-btn-quiet-danger" type="button" onClick={() => void removeCandidates()} disabled={operationBusy}><UserMinus size={15} />移出当前人才库</button>
                  </div>
                </div>
              )}

              {poolError && (
                <div className="tw-alert" role="alert">
                  <span>{poolError}</span>
                  <button className="tw-btn tw-btn-sm" type="button" onClick={refreshMembers}>重新加载</button>
                </div>
              )}

              <div className="tw-table-region" aria-busy={poolLoading}>
                <div className="tw-table-scroll">
                  <table className="tw-table tw-table-members">
                    <thead>
                      <tr>
                        <th className="tw-col-select" scope="col">
                          <input
                            type="checkbox"
                            checked={poolCandidates.length > 0 && poolCandidates.every((candidate) => selectedIds.has(candidate.id))}
                            disabled={!poolCandidates.length}
                            aria-label="选择当前页全部成员"
                            onChange={(event) => setSelectedIds(event.target.checked ? new Set(poolCandidates.map((candidate) => candidate.id)) : new Set())}
                          />
                        </th>
                        <th className="tw-col-name" scope="col">候选人</th>
                        <th className="tw-col-recent" scope="col">最近职位 / 公司</th>
                        <th className="tw-col-positions" scope="col">关联职位</th>
                        <th className="tw-col-place" scope="col">地点 / 学历</th>
                        <th className="tw-col-tags" scope="col">标签</th>
                        <th className="tw-col-time" scope="col">更新时间</th>
                        <th className="tw-col-actions" scope="col">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {poolCandidates.map((candidate) => {
                        const selected = selectedIds.has(candidate.id);
                        return (
                          <tr
                            className={selected ? "is-selected" : ""}
                            key={candidate.id}
                            onClick={() => onOpenCandidate(candidate)}
                          >
                            <td className="tw-col-select">
                              <input
                                type="checkbox"
                                checked={selected}
                                aria-label={"选择 " + candidate.name}
                                onChange={() => setSelectedIds((current) => { const next = new Set(current); if (next.has(candidate.id)) next.delete(candidate.id); else next.add(candidate.id); return next; })}
                                onClick={(event) => event.stopPropagation()}
                              />
                            </td>
                            <td className="tw-col-name">
                              <div className="tw-cell-name">
                                <TwAvatar candidate={candidate} />
                                <span className="tw-stack"><strong>{candidate.name}</strong><small>{candidate.source || "来源未填写"}</small></span>
                              </div>
                            </td>
                            <td className="tw-col-recent">
                              <span className="tw-role">
                                {candidate.current_title || "最近职位未填写"}
                                <small>{candidate.current_company || "最近公司未填写"}</small>
                              </span>
                            </td>
                            <td className="tw-col-positions">
                              <span className="tw-stack">
                                {candidate.positions.length
                                  ? <>{candidate.positions[0].title}{candidate.positions.length > 1 && <small className="tw-more">另关联 {candidate.positions.length - 1} 个职位</small>}</>
                                  : <span className="tw-empty-inline">未分配职位</span>}
                              </span>
                            </td>
                            <td className="tw-col-place"><span className="tw-nowrap">{[candidate.location, candidate.education].filter(Boolean).join(" / ") || "地点与学历未填写"}</span></td>
                            <td className="tw-col-tags" title={candidate.tags.length ? candidate.tags.join("、") : undefined}>
                              {candidate.tags.length ? (
                                <div className="tw-tags">
                                  {candidate.tags.slice(0, 2).map((tag) => <span className="tw-tag" key={tag}>{tag}</span>)}
                                  {candidate.tags.length > 2 && <span className="tw-more">+{candidate.tags.length - 2}</span>}
                                </div>
                              ) : <span className="tw-empty-inline">-</span>}
                            </td>
                            <td className="tw-col-time"><time dateTime={candidate.updated_at} title={formatDateTime(candidate.updated_at)}>{formatDate(candidate.updated_at)}</time></td>
                            <td className="tw-col-actions">
                              <div className="tw-row-actions" onClick={(event) => event.stopPropagation()}>
                                <button className="tw-icon-plain" type="button" onClick={() => onEditCandidate(candidate)} aria-label={"编辑 " + candidate.name} title="编辑"><Pencil size={15} /></button>
                                {candidate.archived_at
                                  ? <button className="tw-icon-plain" type="button" onClick={() => { Promise.resolve(onRestoreCandidate(candidate)).finally(() => { refreshMembers(); refreshPools(); }); }} aria-label={"恢复 " + candidate.name} title="恢复"><RotateCcw size={15} /></button>
                                  : <button className="tw-icon-plain" type="button" onClick={() => { Promise.resolve(onArchiveCandidate(candidate)).finally(() => { refreshMembers(); refreshPools(); }); }} aria-label={"归档 " + candidate.name} title="归档"><Archive size={15} /></button>}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!poolLoading && !poolCandidates.length && (
                    <div className="tw-empty">
                      <span className="tw-empty-icon"><UsersRound size={24} /></span>
                      <p>这个分组还没有候选人</p>
                      {!activePool.archived_at && <button className="tw-btn tw-btn-sm tw-btn-soft" type="button" onClick={() => setPickerOpen(true)}>加入候选人</button>}
                    </div>
                  )}
                </div>
              </div>
              <div className="tw-pagination">
                <span>共 {memberPagination.total} 位成员</span>
                <div className="tw-pages" role="navigation" aria-label="成员分页">
                  <button type="button" disabled={poolLoading || memberPagination.page <= 1} onClick={() => setMemberPage(Math.max(1, memberPagination.page - 1))} aria-label="上一页"><ChevronLeft size={16} /></button>
                  <button className="active" type="button" aria-current="page">{memberPagination.total ? memberPagination.page : 1}</button>
                  <button type="button" disabled={poolLoading || !(memberPagination.has_next ?? memberPagination.page < memberPagination.total_pages)} onClick={() => setMemberPage(memberPagination.page + 1)} aria-label="下一页"><ChevronRight size={16} /></button>
                </div>
                <label className="tw-page-size">每页
                  <select value={memberPageSize} disabled={poolLoading} onChange={(event) => { const size = Number(event.target.value) as PageSize; setMemberPageSize(size); setMemberPage(1); }}>
                    {PAGE_SIZES.map((size) => <option value={size} key={size}>{size}</option>)}
                  </select>
                </label>
              </div>
            </>
          ) : (
            <div className="tw-empty" style={{ flex: "1 1 auto" }}>
              <span className="tw-empty-icon"><FolderKanban size={24} /></span>
              <h2 style={{ margin: 0, fontSize: 16 }}>建立第一个分组</h2>
              <p>用于沉淀高潜人才、专业方向或长期关注人群。</p>
              <button className="tw-btn tw-btn-primary" type="button" onClick={() => openEditor("create")}><Plus size={16} />新建分组</button>
            </div>
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
        <div className="tw-modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !operationBusy && setEditor(null)}>
          <form className="tw-modal tw-modal-md" role="dialog" aria-modal="true" aria-label={editor === "edit" ? "编辑分组" : "新建分组"} onSubmit={(event) => void savePool(event)}>
            <header className="tw-modal-head">
              <div>
                <p className="tw-modal-kicker">人才库分组</p>
                <h2>{editor === "edit" ? "编辑分组" : "新建分组"}</h2>
                <p className="tw-modal-sub">仅建立分组关系，不改变候选人档案。</p>
              </div>
              <button className="tw-icon-plain" type="button" onClick={() => setEditor(null)} disabled={operationBusy} aria-label="关闭"><X size={19} /></button>
            </header>
            <div className="tw-modal-body">
              <div className="tw-form-stack">
                <label className="tw-field tw-field-full">
                  <span className="tw-field-label">名称<span className="tw-req">*</span></span>
                  <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} maxLength={80} autoFocus />
                </label>
                <label className="tw-field tw-field-full">
                  <span className="tw-field-label">说明</span>
                  <textarea value={draft.description ?? ""} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} maxLength={500} rows={3} placeholder="说明这组人才的用途或入库标准" />
                </label>
                <fieldset className="tw-fieldset">
                  <legend className="tw-field-label">标识颜色</legend>
                  <div className="tw-swatch-row">
                    {POOL_COLORS.map((color) => <button className={draft.color === color ? "tw-swatch active" : "tw-swatch"} type="button" key={color} style={{ backgroundColor: color }} onClick={() => setDraft((current) => ({ ...current, color }))} aria-label={"选择颜色 " + color} />)}
                  </div>
                </fieldset>
                {editorError && <p className="tw-error-text" role="alert">{editorError}</p>}
              </div>
            </div>
            <footer className="tw-modal-foot">
              <span className="tw-modal-foot-actions">
                <button className="tw-btn" type="button" onClick={() => setEditor(null)} disabled={operationBusy}>取消</button>
                <button className="tw-btn tw-btn-primary" type="submit" disabled={operationBusy}>{operationBusy ? "正在保存..." : "保存"}</button>
              </span>
            </footer>
          </form>
        </div>
      )}

      {archiveTargets && (
        <div className="tw-modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !operationBusy && setArchiveTargets(null)}>
          <div className="tw-modal" role="alertdialog" aria-modal="true" aria-label="归档人才库">
            <header className="tw-modal-head">
              <div><p className="tw-modal-kicker">操作确认</p><h2>归档 {archiveTargets.length} 个人才库</h2></div>
              <button className="tw-icon-plain" type="button" onClick={() => setArchiveTargets(null)} disabled={operationBusy} aria-label="关闭"><X size={19} /></button>
            </header>
            <div className="tw-modal-body">
              <div className="tw-confirm-body">
                <span className="tw-confirm-icon is-warn"><Archive size={20} /></span>
                <p>选中的人才库将从默认列表隐藏，可在“已归档”视图中恢复。共 {archiveTargets.reduce((sum, pool) => sum + pool.candidate_count, 0)} 条候选人分组关系会保留，不会删除或归档候选人。</p>
              </div>
            </div>
            <footer className="tw-modal-foot">
              <span className="tw-modal-foot-actions">
                <button className="tw-btn" type="button" onClick={() => setArchiveTargets(null)} disabled={operationBusy}>取消</button>
                <button className="tw-btn tw-btn-primary" type="button" onClick={() => void archivePools(archiveTargets)} disabled={operationBusy}>{operationBusy ? "正在处理..." : "确认归档"}</button>
              </span>
            </footer>
          </div>
        </div>
      )}

      {deleteTargets && (
        <div className="tw-modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !operationBusy && setDeleteTargets(null)}>
          <div className="tw-modal" role="alertdialog" aria-modal="true" aria-label="永久删除人才库">
            <header className="tw-modal-head">
              <div><p className="tw-modal-kicker">不可恢复操作</p><h2>永久删除 {deleteTargets.length} 个人才库</h2></div>
              <button className="tw-icon-plain" type="button" onClick={() => setDeleteTargets(null)} disabled={operationBusy} aria-label="关闭"><X size={19} /></button>
            </header>
            <div className="tw-modal-body">
              <div className="tw-confirm-body">
                <span className="tw-confirm-icon is-danger"><Trash2 size={20} /></span>
                <div>
                  <p>将永久删除 {deleteTargets.length} 个已归档人才库，最多涉及 {deleteRelationCount} 位候选人，并解除 {deleteRelationCount} 条分组关系。人才库删除后无法恢复。</p>
                  <p className="tw-hint">候选人档案不会被删除：候选人、职位、附件、备注、活动和履历均保持完整。</p>
                </div>
              </div>
            </div>
            <footer className="tw-modal-foot">
              <span className="tw-modal-foot-actions">
                <button className="tw-btn" type="button" onClick={() => setDeleteTargets(null)} disabled={operationBusy}>取消</button>
                <button className="tw-btn tw-btn-danger" type="button" onClick={() => void permanentlyDeletePools(deleteTargets)} disabled={operationBusy}>{operationBusy ? "正在删除..." : "确认永久删除"}</button>
              </span>
            </footer>
          </div>
        </div>
      )}

    </section>
  );
}
