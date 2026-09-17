import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle, Search, UserPlus, UsersRound, X } from "lucide-react";
import { candidateApi } from "../api";
import type { Candidate, Pagination } from "../types";
import { maskEmail, maskPhone } from "../utils";
import { useDismissableLayer } from "../useDismissableLayer";
import { CandidateAvatar } from "./CandidateAvatar";

export interface CandidatePickerDialogProps {
  open: boolean;
  linkedCandidateIds?: string[];
  excludePositionId?: string;
  excludePoolId?: string;
  loading?: boolean;
  busy?: boolean;
  maxSelection?: number;
  eyebrow?: string;
  title?: string;
  helperText?: string;
  confirmLabel?: string;
  initialQuery?: string;
  externalError?: string;
  onClose: () => void;
  onConfirm: (candidateIds: string[]) => void;
}

const EMPTY_PAGINATION: Pagination = { page: 1, page_size: 20, total: 0, total_pages: 0, has_next: false };
const PAGE_SIZES = [20, 50, 100] as const;

export function CandidatePickerDialog({
  open,
  linkedCandidateIds = [],
  excludePositionId,
  excludePoolId,
  loading: externalLoading = false,
  busy = false,
  maxSelection = 100,
  eyebrow = "关联候选人",
  title = "添加已有候选人",
  helperText = "选择后会建立关联，不会创建重复候选人",
  confirmLabel = "关联",
  initialQuery = "",
  externalError = "",
  onClose,
  onConfirm,
}: CandidatePickerDialogProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [pagination, setPagination] = useState<Pagination>(EMPTY_PAGINATION);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(20);
  const [requestLoading, setRequestLoading] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionError, setSelectionError] = useState("");

  useDismissableLayer({
    open,
    onClose: () => { if (!busy) onClose(); },
    dismissOnOutside: false,
  });

  useEffect(() => {
    if (!open) return;
    const nextQuery = initialQuery.trim();
    setQuery(nextQuery);
    setDebouncedQuery(nextQuery);
    setPage(1);
    setSelectedIds(new Set());
    setSelectionError("");
    setRequestError("");
  }, [excludePoolId, excludePositionId, initialQuery, open]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQuery, pageSize]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setRequestLoading(true);
    setRequestError("");
    void candidateApi.list({
      archived: "exclude",
      search: debouncedQuery || undefined,
      exclude_position_id: excludePositionId,
      exclude_pool_id: excludePoolId,
      sort: "updated_at",
      order: "desc",
      page,
      page_size: pageSize,
    }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      const lastPage = Math.max(1, result.pagination.total_pages);
      if (page > lastPage) {
        setPage(lastPage);
        return;
      }
      setCandidates(result.items);
      setPagination(result.pagination);
    }).catch((error) => {
      if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
      setCandidates([]);
      setPagination(EMPTY_PAGINATION);
      setRequestError(error instanceof Error ? error.message : "候选人加载失败");
    }).finally(() => {
      if (!controller.signal.aborted) setRequestLoading(false);
    });
    return () => controller.abort();
  }, [debouncedQuery, excludePoolId, excludePositionId, open, page, pageSize, retryKey]);

  const linkedIds = useMemo(() => new Set(linkedCandidateIds), [linkedCandidateIds]);
  const availableCandidates = useMemo(
    () => candidates.filter((candidate) => !candidate.archived_at && !linkedIds.has(candidate.id)),
    [candidates, linkedIds],
  );

  if (!open) return null;

  const allVisibleSelected = availableCandidates.length > 0
    && availableCandidates.every((candidate) => selectedIds.has(candidate.id));
  const loading = externalLoading || requestLoading;

  function toggleCandidate(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
        setSelectionError("");
        return next;
      }
      if (next.size >= maxSelection) {
        setSelectionError(`单次最多选择 ${maxSelection} 位候选人`);
        return current;
      }
      next.add(id);
      setSelectionError("");
      return next;
    });
  }

  function toggleVisibleCandidates() {
    if (allVisibleSelected) {
      setSelectedIds((current) => {
        const next = new Set(current);
        availableCandidates.forEach((candidate) => next.delete(candidate.id));
        return next;
      });
      setSelectionError("");
      return;
    }

    setSelectedIds((current) => {
      const next = new Set(current);
      const remaining = Math.max(maxSelection - next.size, 0);
      availableCandidates
        .filter((candidate) => !next.has(candidate.id))
        .slice(0, remaining)
        .forEach((candidate) => next.add(candidate.id));
      setSelectionError(availableCandidates.some((candidate) => !next.has(candidate.id))
        ? `单次最多选择 ${maxSelection} 位候选人`
        : "");
      return next;
    });
  }

  return (
    <div className="tw-modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="tw-modal tw-modal-lg tw-picker" role="dialog" aria-modal="true" aria-labelledby="tw-picker-title">
        <header className="tw-modal-head">
          <div>
            <h2 id="tw-picker-title">{title}</h2>
            <p className="tw-modal-sub">{helperText}</p>
          </div>
          <button className="tw-icon-plain" type="button" onClick={onClose} disabled={busy} aria-label="关闭" title="关闭"><X size={18} /></button>
        </header>

        <div className="tw-picker-toolbar">
          <label className="tw-picker-search">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="姓名、公司、职位" autoFocus aria-label="搜索候选人" />
            {query && <button className="tw-icon-plain" type="button" onClick={() => setQuery("")} aria-label="清除搜索" title="清除"><X size={14} /></button>}
          </label>
          <span className="tw-picker-count">{pagination.total} 位可选</span>
        </div>

        <div className="tw-table-scroll tw-picker-scroll">
          {loading ? (
            <div className="tw-picker-state" role="status"><UsersRound size={22} /><p>正在加载候选人…</p></div>
          ) : requestError ? (
            <div className="tw-picker-state" role="alert"><UsersRound size={22} /><p>{requestError}</p><button className="tw-btn tw-btn-sm" type="button" onClick={() => setRetryKey((value) => value + 1)}>重试</button></div>
          ) : availableCandidates.length ? (
            <table className="tw-table tw-picker-table">
              <thead>
                <tr>
                  <th className="tw-col-select" scope="col">
                    <input type="checkbox" checked={allVisibleSelected} disabled={loading || busy || !availableCandidates.length} onChange={toggleVisibleCandidates} aria-label={allVisibleSelected ? "取消选择当前页" : "选择当前页"} />
                  </th>
                  <th scope="col">候选人</th>
                  <th scope="col">所在城市</th>
                  <th scope="col">已有分组</th>
                </tr>
              </thead>
              <tbody>
                {availableCandidates.map((candidate) => {
                  const selected = selectedIds.has(candidate.id);
                  return (
                    <tr className={selected ? "is-selected" : ""} key={candidate.id} onClick={() => !busy && toggleCandidate(candidate.id)}>
                      <td className="tw-col-select">
                        <input type="checkbox" checked={selected} disabled={busy} onChange={() => toggleCandidate(candidate.id)} onClick={(event) => event.stopPropagation()} aria-label={`选择 ${candidate.name}`} />
                      </td>
                      <td>
                        <div className="tw-cell-name">
                          <CandidateAvatar candidate={candidate} />
                          <span className="tw-stack">
                            <strong>{candidate.name}</strong>
                            <small>{candidate.current_title || "最近职位待补充"}{candidate.current_company ? ` · ${candidate.current_company}` : ""}</small>
                          </span>
                        </div>
                      </td>
                      <td>{candidate.location || "—"}</td>
                      <td>
                        {candidate.talent_pools.length
                          ? <span className="tw-tags">{candidate.talent_pools.slice(0, 3).map((pool) => <span className="tw-tag tw-tag-plain" key={pool.id}>{pool.name}</span>)}{candidate.talent_pools.length > 3 && <span className="tw-more">+{candidate.talent_pools.length - 3}</span>}</span>
                          : <span className="tw-empty-inline">未加入分组</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="tw-picker-state"><UsersRound size={22} /><p>{debouncedQuery ? "没有匹配的可选候选人" : "所有候选人均已关联或暂无可选候选人"}</p></div>
          )}
        </div>

        <div className="tw-pagination tw-picker-pagination">
          <label className="tw-page-size">每页<select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value) as (typeof PAGE_SIZES)[number])}>{PAGE_SIZES.map((size) => <option value={size} key={size}>{size}</option>)}</select></label>
          <div className="tw-pages" role="navigation" aria-label="候选分页">
            <span className="tw-pagination-note">{pagination.total ? `第 ${pagination.page} / ${Math.max(1, pagination.total_pages)} 页` : "0 / 0"}</span>
            <button type="button" disabled={loading || page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} aria-label="上一页"><ChevronLeft size={16} /></button>
            <button type="button" disabled={loading || !(pagination.has_next ?? page < pagination.total_pages)} onClick={() => setPage((value) => value + 1)} aria-label="下一页"><ChevronRight size={16} /></button>
          </div>
        </div>

        {(selectionError || externalError) && <p className="tw-picker-error" role="alert">{selectionError || externalError}</p>}

        <footer className="tw-modal-foot">
          <span className="tw-picker-summary">已选择 {selectedIds.size} 位</span>
          <div className="tw-modal-foot-actions">
            <button className="tw-btn" type="button" onClick={onClose} disabled={busy}>取消</button>
            <button className="tw-btn tw-btn-primary" type="button" disabled={busy || !selectedIds.size} onClick={() => onConfirm(Array.from(selectedIds))}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <UserPlus size={16} />}{busy ? "正在处理…" : confirmLabel}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
