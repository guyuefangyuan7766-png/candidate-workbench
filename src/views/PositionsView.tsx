import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { Pagination as PaginationState, Position, PositionFacets, PositionStatus } from "../types";
import { POSITION_STATUS_LABELS } from "../types";
import { formatDate } from "../utils";
import { useDismissableLayer } from "../useDismissableLayer";
import { PositionStatusBadge } from "../components/PositionStatusBadge";
import { TwSelect } from "./TwSelect";

export type PositionArchiveScope = "active" | "archived" | "all";
export type PositionPageSize = 20 | 50 | 100;

export const POSITION_PAGE_SIZES: readonly PositionPageSize[] = [20, 50, 100];

export interface PositionFilterState {
  status: "all" | PositionStatus;
  archive: PositionArchiveScope;
  department: string;
  owner: string;
  location: string;
}

export interface PositionsViewProps {
  positions: Position[];
  loading: boolean;
  error: string;
  facets: PositionFacets;
  search: string;
  filters: PositionFilterState;
  sort: string;
  pageSize: PositionPageSize;
  pagination: PaginationState;
  selection: ReadonlySet<string>;
  selectionKind: "active" | "archived" | null;
  busyPositionId: string | null;
  departments: string[];
  owners: string[];
  locations: string[];
  onSearchChange: (value: string) => void;
  onFilterChange: (key: keyof PositionFilterState, value: string) => void;
  onSortChange: (value: string) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: PositionPageSize) => void;
  onReload: () => void;
  onClearFilters: () => void;
  onToggleSelection: (positionId: string) => void;
  onToggleAllSelection: (positionIds: string[], selected: boolean) => void;
  onClearSelection: () => void;
  onBulkArchive: () => void;
  onBulkDelete: () => void;
  onOpen: (position: Position) => void;
  onEdit: (position: Position) => void;
  onArchive: (position: Position) => void;
  onRestore: (position: Position) => void;
  onDelete: (position: Position) => void;
  onCreate: () => void;
}

const SORT_OPTIONS = [
  { value: "updated_desc", label: "最近更新" },
  { value: "title_asc", label: "职位名称" },
  { value: "candidates_desc", label: "候选人数" },
  { value: "headcount_desc", label: "计划人数" },
];

function visiblePages(page: number, pageCount: number): Array<number | "gap"> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const pages = new Set<number>([1, pageCount, page, page - 1, page + 1]);
  const sorted = [...pages].filter((value) => value >= 1 && value <= pageCount).sort((left, right) => left - right);
  const result: Array<number | "gap"> = [];
  let previous = 0;
  for (const value of sorted) {
    if (previous && value - previous > 1) result.push("gap");
    result.push(value);
    previous = value;
  }
  return result;
}

function TwCheckbox({ checked, indeterminate = false, disabled = false, label, onChange }: { checked: boolean; indeterminate?: boolean; disabled?: boolean; label: string; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={onChange} onClick={(event) => event.stopPropagation()} />;
}

/* 设计图 04：页头 + 状态统计页签 + 搜索筛选排序行 + 高密度表格 + 数字分页。 */
export function PositionsView(props: PositionsViewProps) {
  const { positions, loading, error, facets, search, filters, sort, pageSize, pagination, selection, selectionKind, busyPositionId } = props;
  const [menuPositionId, setMenuPositionId] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const closeRowMenu = useCallback(() => { setMenuPositionId(null); setMenuAnchor(null); }, []);
  useDismissableLayer({
    open: Boolean(menuPositionId),
    onClose: closeRowMenu,
    isInside: (target) => target instanceof Element && Boolean(target.closest(".tw-menu-wrap")),
  });

  const statusTabActive = (status: "all" | PositionStatus) => filters.archive === "active" && filters.status === status;
  const selectableIds = positions
    .filter((position) => !selectionKind || selectionKind === (position.archived_at ? "archived" : "active"))
    .map((position) => position.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selection.has(id));
  const someSelected = selectableIds.some((id) => selection.has(id));
  const page = pagination.total ? pagination.page : 1;
  const pageCount = Math.max(1, pagination.total_pages);
  const applied: Array<{ key: string; label: string; clear: () => void }> = [];
  if (search) applied.push({ key: "search", label: `搜索：${search}`, clear: () => props.onSearchChange("") });
  if (filters.department !== "all") applied.push({ key: "department", label: `部门：${filters.department}`, clear: () => props.onFilterChange("department", "all") });
  if (filters.owner !== "all") applied.push({ key: "owner", label: `负责人：${filters.owner}`, clear: () => props.onFilterChange("owner", "all") });
  if (filters.location !== "all") applied.push({ key: "location", label: `地点：${filters.location}`, clear: () => props.onFilterChange("location", "all") });
  if (filters.status !== "all") applied.push({ key: "status", label: `状态：${POSITION_STATUS_LABELS[filters.status]}`, clear: () => props.onFilterChange("status", "all") });
  if (filters.archive === "all") applied.push({ key: "archive", label: "范围：全部职位（含已归档）", clear: () => props.onFilterChange("archive", "active") });
  if (filters.archive === "archived") applied.push({ key: "archive", label: "范围：已归档", clear: () => props.onFilterChange("archive", "active") });

  return (
    <section className="tw-page" aria-label="职位管理">
      <header className="tw-page-head">
        <div>
          <h1>职位管理</h1>
          <p className="tw-sub">管理企业的招聘职位，追踪招聘进展，吸引合适的候选人</p>
        </div>
        <div className="tw-page-actions">
          <button className="tw-btn tw-btn-primary" type="button" onClick={props.onCreate}><Plus size={16} />新增职位</button>
        </div>
      </header>

      <div className="tw-scope" aria-label="职位状态统计">
        <button className={statusTabActive("all") ? "active" : ""} type="button" aria-pressed={statusTabActive("all")} onClick={() => { props.onFilterChange("archive", "active"); props.onFilterChange("status", "all"); }}>
          活跃职位<strong>{facets.totals.active}</strong>
        </button>
        {(["open", "draft", "paused", "closed"] as PositionStatus[]).map((status) => (
          <button className={statusTabActive(status) ? "active" : ""} type="button" aria-pressed={statusTabActive(status)} key={status} onClick={() => { props.onFilterChange("archive", "active"); props.onFilterChange("status", status); }}>
            {POSITION_STATUS_LABELS[status]}<strong>{facets.status_counts[status] ?? 0}</strong>
          </button>
        ))}
        <button className={filters.archive === "archived" ? "active" : ""} type="button" aria-pressed={filters.archive === "archived"} onClick={() => { props.onFilterChange("archive", "archived"); props.onFilterChange("status", "all"); }}>
          已归档<strong>{facets.totals.archived}</strong>
        </button>
      </div>

      <div className="tw-toolbar">
        <label className="tw-search" style={{ flex: "0 1 420px" }}>
          <Search size={16} />
          <input value={search} onChange={(event) => props.onSearchChange(event.target.value)} placeholder="搜索职位名称、部门或地点" aria-label="搜索职位" />
          {search && <button type="button" onClick={() => props.onSearchChange("")} aria-label="清除搜索" title="清除搜索"><X size={15} /></button>}
        </label>
        <TwSelect label="部门" value={filters.department} options={[{ value: "all", label: "全部部门" }, ...props.departments.map((value) => ({ value, label: value }))]} onChange={(value) => props.onFilterChange("department", value)} />
        <TwSelect label="负责人" value={filters.owner} options={[{ value: "all", label: "全部负责人" }, ...props.owners.map((value) => ({ value, label: value }))]} onChange={(value) => props.onFilterChange("owner", value)} />
        <TwSelect label="地点" value={filters.location} options={[{ value: "all", label: "全部地点" }, ...props.locations.map((value) => ({ value, label: value }))]} onChange={(value) => props.onFilterChange("location", value)} />
        <div className="tw-chips-spacer" />
        <TwSelect label="" ariaLabel="职位排序" value={sort} options={SORT_OPTIONS} hideDefaultValue={false} accent={false} onChange={props.onSortChange} />
      </div>

      {applied.length > 0 && (
        <div className="tw-applied">
          <span className="tw-applied-count">{pagination.total} 个结果</span>
          {applied.map((chip, index) => (
            <button className="tw-applied-chip" type="button" key={`${chip.key}-${index}`} onClick={chip.clear}>
              {chip.label}<X size={13} />
            </button>
          ))}
          <button className="tw-applied-clear" type="button" onClick={props.onClearFilters}>清除全部筛选</button>
        </div>
      )}

      {selection.size > 0 && (
        <div className="tw-bulk" role="region" aria-label="批量操作">
          <span className="tw-bulk-info"><Check size={16} />已选择 {selection.size} 个{selectionKind === "archived" ? "已归档" : "活动"}职位{selection.size > 100 ? "，单批上限为 100" : ""}</span>
          <div className="tw-bulk-actions">
            <button className="tw-btn tw-btn-sm" type="button" onClick={props.onClearSelection}>取消选择</button>
            {selectionKind === "archived"
              ? <button className="tw-btn tw-btn-sm tw-btn-danger" type="button" disabled={selection.size > 100} onClick={props.onBulkDelete}><Trash2 size={15} />批量永久删除</button>
              : <button className="tw-btn tw-btn-sm tw-btn-quiet-danger" type="button" disabled={selection.size > 100} onClick={props.onBulkArchive}><Archive size={15} />批量归档</button>}
          </div>
        </div>
      )}

      {error && (
        <div className="tw-alert" role="alert">
          <span>{error}</span>
          <button className="tw-btn tw-btn-sm" type="button" onClick={props.onReload}>重新加载</button>
        </div>
      )}

      <div className="tw-table-region">
        {loading ? (
          <div className="tw-skeleton" role="status" aria-label="正在加载职位">
            {Array.from({ length: 6 }, (_, index) => (
              <div className="tw-skeleton-row" key={index}><span className="tw-skeleton-block tw-skeleton-line" /><span className="tw-skeleton-block tw-skeleton-line short" /></div>
            ))}
          </div>
        ) : (
          <div className="tw-table-scroll">
            <table className="tw-table tw-position-table">
              <thead>
                <tr>
                  <th className="tw-col-select"><TwCheckbox checked={allSelected} indeterminate={someSelected} disabled={!selectableIds.length} label={`选择当前页全部${selectionKind === "archived" ? "已归档" : "活动"}职位`} onChange={() => props.onToggleAllSelection(selectableIds, !allSelected)} /></th>
                  <th className="tw-col-position-name">职位名称</th>
                  <th className="tw-col-department">部门</th>
                  <th className="tw-col-location">工作地点</th>
                  <th className="tw-col-owner">负责人</th>
                  <th className="tw-col-status">状态</th>
                  <th className="tw-col-headcount">计划人数</th>
                  <th className="tw-col-candidate-count">候选人数</th>
                  <th className="tw-col-time">更新时间</th>
                  <th className="tw-col-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((position) => {
                  const busy = busyPositionId === position.id;
                  const archived = Boolean(position.archived_at);
                  const selected = selection.has(position.id);
                  const selectable = !selectionKind || selectionKind === (archived ? "archived" : "active");
                  const menuOpen = menuPositionId === position.id;
                  return (
                    <tr className={`${archived ? "is-archived " : ""}${selected ? "is-selected" : ""}`.trim() || undefined} key={position.id} aria-busy={busy || undefined} aria-selected={selected} onClick={() => !busy && props.onOpen(position)}>
                      <td className="tw-col-select"><TwCheckbox checked={selected} disabled={!selectable || busy} label={`选择 ${position.title}`} onChange={() => props.onToggleSelection(position.id)} /></td>
                      <td className="tw-col-position-name"><button className="tw-cell-link" type="button" onClick={(event) => { event.stopPropagation(); props.onOpen(position); }}>{position.title}</button></td>
                      <td className="tw-col-department">{position.department || <span className="tw-empty-inline">未设置部门</span>}</td>
                      <td className="tw-col-location">{position.location || <span className="tw-empty-inline">未设置地点</span>}</td>
                      <td className="tw-col-owner">{position.owner || <span className="tw-empty-inline">未分配</span>}</td>
                      <td className="tw-col-status"><PositionStatusBadge status={position.status} archived={archived} /></td>
                      <td className="tw-col-headcount">{position.headcount}</td>
                      <td className="tw-col-candidate-count">{position.candidate_count}</td>
                      <td className="tw-col-time"><time dateTime={position.updated_at}>{formatDate(position.updated_at)}</time></td>
                      <td className="tw-col-actions" onClick={(event) => event.stopPropagation()}>
                        <div className="tw-row-actions">
                          {!archived && <button className="tw-link-btn" type="button" disabled={busy} onClick={() => props.onEdit(position)}>编辑</button>}
                          <div className="tw-menu-wrap">
                            <button className="tw-link-btn" type="button" disabled={busy} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(event) => { const target = event.currentTarget; setMenuPositionId(menuOpen ? null : position.id); setMenuAnchor(menuOpen ? null : target); }}>
                              更多<ChevronDown size={13} />
                            </button>
                            {menuOpen && (
                              <div className="tw-menu" role="menu" aria-label={`${position.title} 更多操作`}>
                                {archived ? (
                                  <>
                                    <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuPositionId(null); setMenuAnchor(null); props.onRestore(position); }}><RotateCcw size={15} />恢复职位</button>
                                    <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuPositionId(null); setMenuAnchor(null); props.onDelete(position); }}><Trash2 size={15} />永久删除</button>
                                  </>
                                ) : (
                                  <>
                                    <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuPositionId(null); setMenuAnchor(null); props.onEdit(position); }}><Pencil size={15} />编辑职位</button>
                                    <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuPositionId(null); setMenuAnchor(null); props.onArchive(position); }}><Archive size={15} />归档职位</button>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!positions.length && (
              <div className="tw-empty">
                <span className="tw-empty-icon"><BriefcaseBusiness size={24} /></span>
                <p>{search || applied.length ? "没有符合条件的职位" : "还没有招聘职位，先新增一个吧"}</p>
                <button className="tw-btn tw-btn-sm" type="button" onClick={props.onClearFilters}>清除筛选条件</button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="tw-pagination">
        <span>{selection.size ? `已选择 ${selection.size} 项` : "已选择 0 项"}</span>
        <div className="tw-pagination-tail">
          <span>共 {pagination.total} 条</span>
          <div className="tw-pages" role="navigation" aria-label="职位分页">
            <button type="button" disabled={loading || page <= 1} onClick={() => props.onPageChange(page - 1)} aria-label="上一页"><ChevronLeft size={16} /></button>
            {visiblePages(page, pageCount).map((value, index) => value === "gap"
              ? <span className="tw-ellipsis" key={`gap-${index}`}>···</span>
              : <button className={value === page ? "active" : ""} type="button" key={value} aria-current={value === page ? "page" : undefined} disabled={loading} onClick={() => props.onPageChange(value)}>{value}</button>)}
            <button type="button" disabled={loading || !(pagination.has_next ?? page < pageCount)} onClick={() => props.onPageChange(page + 1)} aria-label="下一页"><ChevronRight size={16} /></button>
          </div>
        </div>
        <label className="tw-page-size">
          每页
          <select value={pageSize} disabled={loading} onChange={(event) => props.onPageSizeChange(Number(event.target.value) as PositionPageSize)}>
            {POSITION_PAGE_SIZES.map((size) => <option value={size} key={size}>{size}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}
