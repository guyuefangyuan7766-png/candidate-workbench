import { useRef, useState } from "react";
import {
  Archive,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileDown,
  FileSpreadsheet,
  Filter,
  GraduationCap,
  Link2,
  List,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  UsersRound,
  X,
} from "lucide-react";
import type { Candidate, CandidateFacets, Pagination as PaginationState, Position, TalentPool } from "../types";
import { formatDate, formatDateTime } from "../utils";
import { useDismissableLayer } from "../useDismissableLayer";
import { TwAvatar } from "./TwAvatar";
import { TwGroupedCandidates } from "./CandidatesGroupedView";
import { TwSelect } from "./TwSelect";

export type CandidateArchiveScope = "active" | "archived" | "all";
export type CandidateListView = "list" | "grouped";
export type PageSize = 20 | 50 | 100;

export const PAGE_SIZES: readonly PageSize[] = [20, 50, 100];

export interface CandidateFilterState {
  source: string;
  owner: string;
  tag: string;
  position: string;
  pool: string;
  education: string;
  school: string;
  gender: string;
  jobStatus: string;
}

export interface CandidatesViewProps {
  candidates: Candidate[];
  loading: boolean;
  error: string;
  scope: CandidateArchiveScope;
  scopeCounts: { active: number; archived: number; total: number };
  search: string;
  filters: CandidateFilterState;
  facets: CandidateFacets;
  positions: Position[];
  talentPools: TalentPool[];
  sort: string;
  view: CandidateListView;
  pageSize: PageSize;
  pagination: PaginationState;
  selection: ReadonlySet<string>;
  selectionKind: "active" | "archived" | null;
  onScopeChange: (scope: CandidateArchiveScope) => void;
  onSearchChange: (value: string) => void;
  onFilterChange: (key: keyof CandidateFilterState, value: string) => void;
  onClearFilters: () => void;
  onSortChange: (value: string) => void;
  onViewChange: (view: CandidateListView) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: PageSize) => void;
  onReload: () => void;
  onToggleSelection: (candidateId: string) => void;
  onToggleAllSelection: (candidateIds: string[], selected: boolean) => void;
  onOpenCandidate: (candidate: Candidate) => void;
  onEditCandidate: (candidate: Candidate) => void;
  onArchiveCandidate: (candidate: Candidate) => void;
  onRestoreCandidate: (candidate: Candidate) => void;
  onDeleteCandidate: (candidate: Candidate) => void;
  onLinkPositions: (candidateIds: string[]) => void;
  onOpenPosition: (position: Position) => void;
  onClearSelection: () => void;
  onBulkArchive: () => void;
  onBulkDelete: () => void;
  onBulkLink: () => void;
  onImport: () => void;
  onExport: (format: "xlsx" | "csv") => void;
  onCreate: () => void;
}

const POSITION_STATUS_LABELS: Record<Position["status"], string> = {
  draft: "草稿",
  open: "招聘中",
  paused: "已暂停",
  closed: "已关闭",
};

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

export function CandidatesView(props: CandidatesViewProps) {
  const {
    candidates, loading, error, scope, scopeCounts, search, filters, facets, positions, talentPools, sort, view,
    pageSize, pagination, selection, selectionKind,
  } = props;
  const [exportOpen, setExportOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const advancedChipRef = useRef<HTMLButtonElement>(null);
  const advancedPanelRef = useRef<HTMLDivElement>(null);

  useDismissableLayer({
    open: exportOpen,
    onClose: () => setExportOpen(false),
    within: exportRef,
  });
  useDismissableLayer({
    open: advancedOpen,
    onClose: () => setAdvancedOpen(false),
    within: advancedPanelRef,
    isInside: (target) => Boolean(advancedChipRef.current && advancedChipRef.current.contains(target)),
  });

  const advancedFilterCount = [filters.school, filters.gender, filters.jobStatus, filters.owner, filters.tag]
    .filter((value) => value && value !== "all").length;
  const applied: Array<{ key: string; label: string; clear: () => void }> = [];
  if (search) applied.push({ key: "search", label: `搜索：${search}`, clear: () => props.onSearchChange("") });
  if (filters.education !== "all") applied.push({ key: "education", label: `学历：${filters.education}`, clear: () => props.onFilterChange("education", "all") });
  if (filters.pool !== "all") applied.push({ key: "pool", label: filters.pool === "unassigned" ? "人才库：未分组" : `人才库：${talentPools.find((item) => item.id === filters.pool)?.name ?? "未知"}`, clear: () => props.onFilterChange("pool", "all") });
  if (filters.position !== "all") applied.push({ key: "position", label: filters.position === "unassigned" ? "关联职位：未分配" : `关联职位：${positions.find((item) => item.id === filters.position)?.title ?? "未知"}`, clear: () => props.onFilterChange("position", "all") });
  if (filters.source !== "all") applied.push({ key: "source", label: `来源：${filters.source}`, clear: () => props.onFilterChange("source", "all") });
  if (filters.school !== "all") applied.push({ key: "school", label: `学校：${filters.school}`, clear: () => props.onFilterChange("school", "all") });
  if (filters.gender !== "all") applied.push({ key: "gender", label: `性别：${filters.gender}`, clear: () => props.onFilterChange("gender", "all") });
  if (filters.jobStatus !== "all") applied.push({ key: "jobStatus", label: `求职状态：${filters.jobStatus}`, clear: () => props.onFilterChange("jobStatus", "all") });
  if (filters.owner !== "all") applied.push({ key: "owner", label: `负责人：${filters.owner}`, clear: () => props.onFilterChange("owner", "all") });
  if (filters.tag !== "all") applied.push({ key: "tag", label: `标签：${filters.tag}`, clear: () => props.onFilterChange("tag", "all") });
  if (scope !== "active" && view === "list") applied.push({ key: "scope", label: scope === "archived" ? "仅已归档" : "含已归档", clear: () => props.onScopeChange("active") });

  const selectableIds = candidates
    .filter((candidate) => !selectionKind || selectionKind === (candidate.archived_at ? "archived" : "active"))
    .map((candidate) => candidate.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selection.has(id));
  const someSelected = selectableIds.some((id) => selection.has(id));
  const page = pagination.total ? pagination.page : 1;
  const pageCount = Math.max(1, pagination.total_pages);

  return (
    <section className="tw-page" aria-label="候选人库">
      <header className="tw-page-head">
        <h1>候选人库</h1>
        <div className="tw-page-actions">
          <button className="tw-btn" type="button" onClick={props.onImport}><Upload size={16} />导入</button>
          <div className="tw-menu-wrap" ref={exportRef}>
            <button className="tw-btn" type="button" onClick={() => setExportOpen((current) => !current)} aria-expanded={exportOpen} aria-haspopup="menu">
              <Download size={16} />导出<ChevronDown size={14} />
            </button>
            {exportOpen && (
              <div className="tw-menu" role="menu" aria-label="导出候选人">
                <p className="tw-menu-note">导出当前筛选结果（{pagination.total} 位）</p>
                <button type="button" role="menuitem" onClick={() => { setExportOpen(false); props.onExport("xlsx"); }}><FileSpreadsheet size={15} />Excel（XLSX）</button>
                <button type="button" role="menuitem" onClick={() => { setExportOpen(false); props.onExport("csv"); }}><FileDown size={15} />CSV</button>
              </div>
            )}
          </div>
          <button className="tw-btn tw-btn-primary" type="button" onClick={props.onCreate}><Plus size={16} />新增候选人</button>
        </div>
      </header>

      <div className="tw-scope" aria-label="候选人档案范围">
        <button className={scope === "active" ? "active" : ""} type="button" aria-pressed={scope === "active"} onClick={() => props.onScopeChange("active")}>
          在库候选人<strong>{scopeCounts.active}</strong>
        </button>
        <button className={scope === "archived" ? "active" : ""} type="button" aria-pressed={scope === "archived"} onClick={() => props.onScopeChange("archived")}>
          已归档<strong>{scopeCounts.archived}</strong>
        </button>
        <button className={scope === "all" ? "active" : ""} type="button" aria-pressed={scope === "all"} onClick={() => props.onScopeChange("all")}>
          全部档案<strong>{scopeCounts.total}</strong>
        </button>
      </div>

      <div className="tw-toolbar">
        <label className="tw-search">
          <Search size={17} />
          <input value={search} onChange={(event) => props.onSearchChange(event.target.value)} placeholder="姓名、公司、职位、学校或标签" aria-label="搜索候选人" />
          {search && <button type="button" onClick={() => props.onSearchChange("")} aria-label="清除搜索" title="清除"><X size={15} /></button>}
        </label>
      </div>

      <div className="tw-chips" aria-label="候选人筛选">
        <TwSelect
          label="学历"
          value={filters.education}
          onChange={(value) => props.onFilterChange("education", value)}
          options={[{ value: "all", label: "全部学历" }, ...facets.education.map((item) => ({ value: item, label: item }))]}
        />
        <TwSelect
          label="人才库"
          value={filters.pool}
          onChange={(value) => props.onFilterChange("pool", value)}
          options={[{ value: "all", label: "全部人才库" }, { value: "unassigned", label: "未加入人才库" }, ...talentPools.map((pool) => ({ value: pool.id, label: pool.archived_at ? `${pool.name}（已归档）` : pool.name }))]}
        />
        <TwSelect
          label="关联职位"
          value={filters.position}
          onChange={(value) => props.onFilterChange("position", value)}
          options={[{ value: "all", label: "全部职位" }, { value: "unassigned", label: "未分配职位" }, ...positions.map((position) => ({ value: position.id, label: position.archived_at ? `${position.title}（已归档）` : position.title }))]}
        />
        <TwSelect
          label="来源"
          value={filters.source}
          onChange={(value) => props.onFilterChange("source", value)}
          options={[{ value: "all", label: "全部来源" }, ...facets.sources.map((item) => ({ value: item, label: item }))]}
        />
        <button
          ref={advancedChipRef}
          className={`tw-chip${advancedOpen || advancedFilterCount ? " is-active" : ""}`}
          type="button"
          onClick={() => setAdvancedOpen((current) => !current)}
          aria-expanded={advancedOpen}
        >
          <Filter size={15} />更多筛选{advancedFilterCount ? <span className="tw-chip-count">{advancedFilterCount}</span> : null}
        </button>
        <span className="tw-chips-spacer" />
        <div className="tw-seg" role="group" aria-label="视图切换">
          <button className={view === "list" ? "active" : ""} type="button" aria-pressed={view === "list"} onClick={() => props.onViewChange("list")}><List size={15} />列表</button>
          <button className={view === "grouped" ? "active" : ""} type="button" aria-pressed={view === "grouped"} onClick={() => props.onViewChange("grouped")}><UsersRound size={15} />按职位</button>
        </div>
      </div>

      {advancedOpen && (
        <div className="tw-panel" ref={advancedPanelRef}>
          <div className="tw-panel-grid">
            <TwSelect
              label="学校"
              ariaLabel="学校筛选"
              value={filters.school}
              onChange={(value) => props.onFilterChange("school", value)}
              options={[{ value: "all", label: "全部学校" }, ...facets.schools.map((item) => ({ value: item, label: item }))]}
            />
            <TwSelect
              label="性别"
              ariaLabel="性别筛选"
              value={filters.gender}
              onChange={(value) => props.onFilterChange("gender", value)}
              options={[{ value: "all", label: "全部性别" }, ...facets.genders.map((item) => ({ value: item, label: item }))]}
            />
            <TwSelect
              label="求职状态"
              ariaLabel="求职状态筛选"
              value={filters.jobStatus}
              onChange={(value) => props.onFilterChange("jobStatus", value)}
              options={[{ value: "all", label: "全部求职状态" }, ...facets.job_seeking_statuses.map((item) => ({ value: item, label: item }))]}
            />
            <TwSelect
              label="负责人"
              ariaLabel="负责人筛选"
              value={filters.owner}
              onChange={(value) => props.onFilterChange("owner", value)}
              options={[{ value: "all", label: "全部负责人" }, ...facets.owners.map((item) => ({ value: item, label: item }))]}
            />
            <TwSelect
              label="标签"
              ariaLabel="标签筛选"
              value={filters.tag}
              onChange={(value) => props.onFilterChange("tag", value)}
              options={[{ value: "all", label: "全部标签" }, ...facets.tags.map((item) => ({ value: item, label: item }))]}
            />
            <TwSelect
              label="排序"
              ariaLabel="排序方式"
              value={sort}
              hideDefaultValue={false}
              onChange={props.onSortChange}
              options={[
                { value: "updated_desc", label: "最近更新（降序）" },
                { value: "updated_asc", label: "最近更新（升序）" },
                { value: "created_desc", label: "创建时间" },
                { value: "name_asc", label: "姓名" },
                { value: "experience_desc", label: "工作年限" }
              ]}
            />
        </div>
        </div>
      )}

      {applied.length > 0 && (
        <div className="tw-applied">
          {applied.map((chip) => (
            <button className="tw-applied-chip" type="button" key={chip.key} onClick={chip.clear}>
              {chip.label}<X size={13} />
            </button>
          ))}
          <button className="tw-applied-clear" type="button" onClick={() => { props.onClearFilters(); props.onSearchChange(""); }}>清除全部</button>
        </div>
      )}

      {error && (
        <div className="tw-alert" role="alert">
          <span>{error}</span>
          <button className="tw-btn tw-btn-sm" type="button" onClick={props.onReload}>重新加载</button>
        </div>
      )}

      {selection.size > 0 && (
        <div className="tw-bulk" role="region" aria-label="批量操作">
          <span className="tw-bulk-info">
            <Check size={16} />已选择 {selection.size} 位{selectionKind === "archived" ? "已归档" : "活动"}候选人
          </span>
          <div className="tw-bulk-actions">
            <button className="tw-btn tw-btn-sm" type="button" onClick={props.onClearSelection}>取消选择</button>
            {selectionKind === "archived" ? (
              <button className="tw-btn tw-btn-sm tw-btn-danger" type="button" onClick={props.onBulkDelete}><Trash2 size={15} />批量永久删除</button>
            ) : (
              <>
                <button className="tw-btn tw-btn-sm" type="button" onClick={props.onBulkLink}><BriefcaseBusiness size={15} />关联职位</button>
                <button className="tw-btn tw-btn-sm tw-btn-primary" type="button" onClick={props.onBulkArchive}><Archive size={15} />批量归档</button>
              </>
            )}
          </div>
        </div>
      )}

      <div className="tw-table-region" aria-busy={loading}>
        {loading && candidates.length === 0 ? (
          <div className="tw-skeleton" aria-label="正在加载候选人">
            {[0, 1, 2, 3, 4, 5].map((item) => (
              <div className="tw-skeleton-row" key={item}>
                <span className="tw-skeleton-block tw-skeleton-avatar" />
                <span className="tw-skeleton-block tw-skeleton-line" />
                <span className="tw-skeleton-block tw-skeleton-line short" />
              </div>
            ))}
          </div>
        ) : view === "grouped" ? (
          <TwGroupedCandidates
            candidates={candidates}
            archived={scope === "archived"}
            selection={selection}
            selectionKind={selectionKind}
            onToggle={props.onToggleSelection}
            onOpen={props.onOpenCandidate}
            onEdit={props.onEditCandidate}
            onArchive={props.onArchiveCandidate}
            onRestore={props.onRestoreCandidate}
            onLinkPositions={props.onLinkPositions}
            onOpenPosition={props.onOpenPosition}
          />
        ) : (
          <div className="tw-table-scroll">
            <table className="tw-table tw-table-candidates">
              <thead>
                <tr>
                  <th className="tw-col-select" scope="col">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(node) => { if (node) node.indeterminate = someSelected && !allSelected; }}
                      disabled={!selectableIds.length}
                      onChange={(event) => props.onToggleAllSelection(selectableIds, event.target.checked)}
                      aria-label="选择当前页全部候选人"
                    />
                  </th>
                  <th className="tw-col-name" scope="col">姓名</th>
                  <th className="tw-col-recent" scope="col">最近职位 / 公司</th>
                  <th className="tw-col-positions" scope="col">关联职位</th>
                  <th className="tw-col-pools" scope="col">人才库分组</th>
                  <th className="tw-col-place" scope="col">地点 / 学历</th>
                  <th scope="col" className="tw-col-tags">标签</th>
                  <th className="tw-sortable tw-col-time" scope="col" onClick={() => props.onSortChange(sort === "updated_desc" ? "updated_asc" : "updated_desc")}>
                    <span className="tw-th-sort">更新时间<ChevronDown size={13} /></span>
                  </th>
                  <th className="tw-col-actions" scope="col"><span className="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((candidate) => {
                  const archived = Boolean(candidate.archived_at);
                  const selected = selection.has(candidate.id);
                  const selectable = !selectionKind || selectionKind === (archived ? "archived" : "active");
                  return (
                    <tr
                      key={candidate.id}
                      className={`${selected ? "is-selected" : ""}${archived ? " is-archived" : ""}`}
                      onClick={() => props.onOpenCandidate(candidate)}
                    >
                      <td className="tw-col-select">
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={!selectable}
                          aria-label={`选择 ${candidate.name}`}
                          onChange={() => props.onToggleSelection(candidate.id)}
                          onClick={(event) => event.stopPropagation()}
                        />
                      </td>
                      <td className="tw-col-name">
                        <div className="tw-cell-name">
                          <TwAvatar candidate={candidate} />
                          <span className="tw-stack">
                            <strong>{candidate.name}</strong>
                          </span>
                        </div>
                      </td>
                      <td className="tw-col-recent">
                        <span className="tw-role">
                          {candidate.current_title || "最近职位未填写"}
                          <small>{candidate.current_company || "最近公司未填写"}</small>
                        </span>
                      </td>
                      <td className="tw-col-positions">
                        <span className="tw-nowrap">
                          {candidate.positions.length ? (
                            <>
                              {candidate.positions[0].title}
                              {candidate.positions.length > 1 && <small className="tw-more"> +{candidate.positions.length - 1}</small>}
                            </>
                          ) : <span className="tw-empty-inline">未分配职位</span>}
                        </span>
                      </td>
                      <td className="tw-col-pools" title={candidate.talent_pools.map((pool) => pool.name).join("、") || "未加入人才库"}>
                        <span className="tw-pool-cells">
                          {candidate.talent_pools.length ? (
                            <>
                              <span className="tw-tag">{candidate.talent_pools[0].name}</span>
                              {candidate.talent_pools.length > 1 && <small className="tw-more">+{candidate.talent_pools.length - 1}</small>}
                            </>
                          ) : <span className="tw-empty-inline">未加入人才库</span>}
                        </span>
                      </td>
                      <td className="tw-col-place">
                        <span className="tw-nowrap">{[candidate.location, candidate.education].filter(Boolean).join(" / ") || "地点与学历未填写"}</span>
                      </td>
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
                          {!archived && (
                            <button className="tw-icon-plain" type="button" onClick={() => props.onLinkPositions([candidate.id])} aria-label={`关联 ${candidate.name} 到职位`} title="关联职位"><Link2 size={15} /></button>
                          )}
                          {!archived ? (
                            <>
                              <button className="tw-icon-plain" type="button" onClick={() => props.onEditCandidate(candidate)} aria-label={`编辑 ${candidate.name}`} title="编辑"><Pencil size={15} /></button>
                              <button className="tw-icon-plain" type="button" onClick={() => props.onArchiveCandidate(candidate)} aria-label={`归档 ${candidate.name}`} title="归档"><Archive size={15} /></button>
                            </>
                          ) : (
                            <>
                              <button className="tw-icon-plain" type="button" onClick={() => props.onRestoreCandidate(candidate)} aria-label={`恢复 ${candidate.name}`} title="恢复"><RotateCcw size={15} /></button>
                              <button className="tw-icon-plain" type="button" onClick={() => props.onDeleteCandidate(candidate)} aria-label={`永久删除 ${candidate.name}`} title="永久删除"><Trash2 size={15} /></button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!candidates.length && (
              <div className="tw-empty">
                <span className="tw-empty-icon"><UsersRound size={24} /></span>
                <p>{scope === "archived" ? "暂无已归档候选人" : "没有符合条件的候选人"}</p>
                <button className="tw-btn tw-btn-sm" type="button" onClick={() => { props.onClearFilters(); props.onSearchChange(""); props.onScopeChange("active"); }}>清除筛选条件</button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="tw-pagination">
        <span>共 {pagination.total} 条</span>
        <div className="tw-pages" role="navigation" aria-label="候选人分页">
          <button type="button" disabled={loading || page <= 1} onClick={() => props.onPageChange(page - 1)} aria-label="上一页"><ChevronLeft size={16} /></button>
          {visiblePages(page, pageCount).map((value, index) => value === "gap"
            ? <span className="tw-ellipsis" key={`gap-${index}`}>···</span>
            : <button className={value === page ? "active" : ""} type="button" key={value} aria-current={value === page ? "page" : undefined} disabled={loading} onClick={() => props.onPageChange(value)}>{value}</button>)}
          <button type="button" disabled={loading || !(pagination.has_next ?? page < pageCount)} onClick={() => props.onPageChange(page + 1)} aria-label="下一页"><ChevronRight size={16} /></button>
        </div>
        <label className="tw-page-size">
          每页
          <select value={pageSize} disabled={loading} onChange={(event) => props.onPageSizeChange(Number(event.target.value) as PageSize)}>
            {PAGE_SIZES.map((size) => <option value={size} key={size}>{size}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}
