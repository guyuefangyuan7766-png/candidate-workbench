import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Search, UserPlus, UsersRound, X } from "lucide-react";
import { candidateApi } from "../api";
import type { Candidate, Pagination } from "../types";
import { maskEmail, maskPhone } from "../utils";
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
    <div className="modal-layer candidate-picker-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="modal candidate-picker-dialog" role="dialog" aria-modal="true" aria-label={title} aria-busy={busy || loading || undefined}>
        <header className="modal-header candidate-picker-header">
          <div><p className="drawer-kicker">{eyebrow}</p><h2>{title}</h2></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="关闭" title="关闭"><X size={19} /></button>
        </header>

        <div className="candidate-picker-toolbar">
          <label className="candidate-picker-search">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索姓名、公司、职位或标签" autoFocus />
            {query && <button type="button" onClick={() => setQuery("")} aria-label="清除搜索" title="清除"><X size={15} /></button>}
          </label>
          <span className="candidate-picker-result-count">{pagination.total} 位可选</span>
        </div>

        <div className="candidate-picker-selection-bar">
          <label>
            <input type="checkbox" checked={allVisibleSelected} disabled={loading || busy || !availableCandidates.length} onChange={toggleVisibleCandidates} />
            <span>{allVisibleSelected ? "取消选择当前页" : "选择当前页"}</span>
          </label>
          <strong>已选择 {selectedIds.size} 位</strong>
        </div>

        <div className="candidate-picker-body">
          {loading ? (
            <div className="candidate-picker-state" role="status"><UsersRound size={24} /><p>正在加载候选人...</p></div>
          ) : requestError ? (
            <div className="candidate-picker-state" role="alert"><UsersRound size={24} /><p>{requestError}</p><button className="button secondary-button" type="button" onClick={() => setRetryKey((value) => value + 1)}>重试</button></div>
          ) : availableCandidates.length ? (
            <div className="candidate-picker-list">
              {availableCandidates.map((candidate) => {
                const selected = selectedIds.has(candidate.id);
                return (
                  <label className={`candidate-picker-item ${selected ? "is-selected" : ""}`} key={candidate.id}>
                    <input type="checkbox" checked={selected} disabled={busy} onChange={() => toggleCandidate(candidate.id)} />
                    <span className="candidate-picker-check" aria-hidden="true">{selected && <Check size={13} />}</span>
                    <CandidateAvatar candidate={candidate} />
                    <span className="candidate-picker-identity"><strong>{candidate.name}</strong><small>{candidate.current_title || "职位待补充"}{candidate.current_company ? ` · ${candidate.current_company}` : ""}{candidate.location ? ` · ${candidate.location}` : ""}</small></span>
                    <span className="candidate-picker-contact">{candidate.phone ? maskPhone(candidate.phone) : candidate.email ? maskEmail(candidate.email) : "联系方式受保护"}</span>
                    <span className="candidate-picker-source">{candidate.source || "来源未设置"}</span>
                  </label>
                );
              })}
            </div>
          ) : (
            <div className="candidate-picker-state"><UsersRound size={24} /><p>{debouncedQuery ? "没有匹配的可选候选人" : "所有候选人均已关联或暂无可选候选人"}</p></div>
          )}
        </div>

        <div className="candidate-picker-pagination pagination-compact">
          <label>每页<select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value) as (typeof PAGE_SIZES)[number])}>{PAGE_SIZES.map((size) => <option value={size} key={size}>{size}</option>)}</select></label>
          <span>{pagination.total ? `${pagination.page} / ${Math.max(1, pagination.total_pages)}` : "0 / 0"}</span>
          <button className="icon-button" type="button" disabled={loading || page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} aria-label="上一页" title="上一页"><ChevronLeft size={16} /></button>
          <button className="icon-button" type="button" disabled={loading || !(pagination.has_next ?? page < pagination.total_pages)} onClick={() => setPage((value) => value + 1)} aria-label="下一页" title="下一页"><ChevronRight size={16} /></button>
        </div>

        {(selectionError || externalError) && <p className="candidate-picker-error" role="alert">{selectionError || externalError}</p>}

        <footer className="modal-footer candidate-picker-footer">
          <span className="candidate-picker-footer-summary">{helperText}</span>
          <span className="modal-footer-spacer" />
          <button className="button secondary-button" type="button" onClick={onClose} disabled={busy}>取消</button>
          <button className="button primary-button" type="button" disabled={busy || !selectedIds.size} onClick={() => onConfirm(Array.from(selectedIds))}>
            <UserPlus size={16} />{busy ? "正在处理..." : `${confirmLabel} ${selectedIds.size} 位候选人`}
          </button>
        </footer>
      </section>
    </div>
  );
}
