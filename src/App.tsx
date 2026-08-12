import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Bot,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileDown,
  FileSpreadsheet,
  Filter,
  FolderKanban,
  LayoutDashboard,
  List,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  UsersRound,
  X,
} from "lucide-react";
import {
  candidateApi,
  candidateExportUrl,
  getAgentStatus,
  getDashboard,
  positionApi,
  talentPoolApi,
  ApiError,
  type CandidateDetail,
  type PermanentDeletePreview,
} from "./api";
import {
  POSITION_STATUSES,
  POSITION_STATUS_LABELS,
  type Candidate,
  type CandidateDraft,
  type CandidateFacets,
  type CandidateFilters,
  type DashboardData,
  type ImportResult,
  type Pagination as PaginationState,
  type Position,
  type PositionDraft,
  type PositionFacets,
  type PositionFilters,
  type PositionStatus,
  type TalentPool,
} from "./types";
import { AssistantDrawer } from "./components/AssistantDrawer";
import { CandidateDrawer, type DrawerMode } from "./components/CandidateDrawer";
import { CandidateGroupedView } from "./components/CandidateGroupedView";
import { CandidatePickerDialog } from "./components/CandidatePickerDialog";
import { CandidateTable } from "./components/CandidateTable";
import { hasRecoverableImportTask, ImportWizard } from "./components/ImportWizard";
import { Overview } from "./components/Overview";
import { PositionDetailPage } from "./components/PositionDetailPage";
import { PositionFormDrawer, type PositionFormMode } from "./components/PositionFormDrawer";
import { PositionStatusBadge } from "./components/PositionStatusBadge";
import { PositionTable } from "./components/PositionTable";
import { PermanentDeleteDialog, type PermanentDeleteEntity } from "./components/PermanentDeleteDialog";
import { TalentPoolPage } from "./components/TalentPoolPage";

type Page = "dashboard" | "candidates" | "talent-pools" | "positions" | "position-detail";
type CandidateView = "list" | "grouped";
type ArchiveFilter = "active" | "archived" | "all";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "candidate-workbench.sidebar-collapsed";
const PAGE_SIZES = [20, 50, 100] as const;
type PageSize = (typeof PAGE_SIZES)[number];
const EMPTY_PAGINATION: PaginationState = { page: 1, page_size: 20, total: 0, total_pages: 0, has_next: false };
const EMPTY_CANDIDATE_FACETS: CandidateFacets = {
  sources: [], owners: [], tags: [], education: [], schools: [], genders: [], job_seeking_statuses: [],
  totals: { total: 0, active: 0, archived: 0 },
};
const EMPTY_POSITION_FACETS: PositionFacets = {
  departments: [], owners: [], locations: [],
  totals: { total: 0, active: 0, archived: 0 },
  status_counts: {},
};

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debouncedValue;
}

function readSidebarCollapsedPreference() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

interface ConfirmAction {
  title: string;
  message: string;
  confirmLabel: string;
  tone?: "danger" | "default";
  run: () => Promise<void>;
}

interface ToastState {
  message: string;
  actionLabel?: string;
  action?: () => Promise<void> | void;
  tone?: "success" | "warning";
}

interface PermanentDeleteRequest {
  entity: PermanentDeleteEntity;
  ids: string[];
  preview: PermanentDeletePreview | null;
  loading: boolean;
  committing: boolean;
  error: string;
}

const pageMeta: Record<Exclude<Page, "position-detail">, { label: string; icon: typeof LayoutDashboard }> = {
  dashboard: { label: "工作台", icon: LayoutDashboard },
  candidates: { label: "候选人库", icon: UsersRound },
  "talent-pools": { label: "人才库分组", icon: FolderKanban },
  positions: { label: "职位管理", icon: BriefcaseBusiness },
};

function initialRoute(): { page: Page; positionId: string | null } {
  const positionMatch = window.location.pathname.match(/^\/positions\/([^/]+)$/);
  if (positionMatch) return { page: "position-detail", positionId: decodeURIComponent(positionMatch[1]) };
  if (window.location.pathname === "/candidates") return { page: "candidates", positionId: null };
  if (window.location.pathname === "/talent-pools") return { page: "talent-pools", positionId: null };
  if (window.location.pathname === "/positions") return { page: "positions", positionId: null };
  return { page: "dashboard", positionId: null };
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? `${fallback}：${error.message}` : fallback;
}

function App() {
  const initial = useMemo(initialRoute, []);
  const [page, setPage] = useState<Page>(initial.page);
  const [activePositionId, setActivePositionId] = useState<string | null>(initial.positionId);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [positionLookup, setPositionLookup] = useState<Position[]>([]);
  const [talentPools, setTalentPools] = useState<TalentPool[]>([]);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [candidateFacets, setCandidateFacets] = useState<CandidateFacets>(EMPTY_CANDIDATE_FACETS);
  const [positionFacets, setPositionFacets] = useState<PositionFacets>(EMPTY_POSITION_FACETS);

  const [candidateSearch, setCandidateSearch] = useState("");
  const [candidateSource, setCandidateSource] = useState("all");
  const [candidateOwner, setCandidateOwner] = useState("all");
  const [candidateTag, setCandidateTag] = useState("all");
  const [candidatePosition, setCandidatePosition] = useState("all");
  const [candidatePool, setCandidatePool] = useState("all");
  const [candidateEducation, setCandidateEducation] = useState("all");
  const [candidateSchool, setCandidateSchool] = useState("all");
  const [candidateGender, setCandidateGender] = useState("all");
  const [candidateJobStatus, setCandidateJobStatus] = useState("all");
  const [candidateArchive, setCandidateArchive] = useState<ArchiveFilter>("active");
  const [candidateSort, setCandidateSort] = useState("updated_desc");
  const [candidatePage, setCandidatePage] = useState(1);
  const [candidatePageSize, setCandidatePageSize] = useState<PageSize>(20);
  const [candidatePagination, setCandidatePagination] = useState<PaginationState>(EMPTY_PAGINATION);
  const [candidateListLoading, setCandidateListLoading] = useState(true);
  const [candidateListError, setCandidateListError] = useState("");
  const [candidateView, setCandidateView] = useState<CandidateView>("list");
  const [candidateFiltersOpen, setCandidateFiltersOpen] = useState(false);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(new Set());

  const [positionSearch, setPositionSearch] = useState("");
  const [positionStatus, setPositionStatus] = useState<"all" | PositionStatus>("all");
  const [positionDepartment, setPositionDepartment] = useState("all");
  const [positionOwner, setPositionOwner] = useState("all");
  const [positionLocation, setPositionLocation] = useState("all");
  const [positionArchive, setPositionArchive] = useState<ArchiveFilter>("active");
  const [positionSort, setPositionSort] = useState("updated_desc");
  const [positionPage, setPositionPage] = useState(1);
  const [positionPageSize, setPositionPageSize] = useState<PageSize>(20);
  const [positionPagination, setPositionPagination] = useState<PaginationState>(EMPTY_PAGINATION);
  const [positionListLoading, setPositionListLoading] = useState(true);
  const [positionListError, setPositionListError] = useState("");
  const [positionFiltersOpen, setPositionFiltersOpen] = useState(false);
  const [selectedPositionIds, setSelectedPositionIds] = useState<Set<string>>(new Set());

  const [drawerMode, setDrawerMode] = useState<DrawerMode>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [candidateDetail, setCandidateDetail] = useState<CandidateDetail | null>(null);
  const [sensitiveLoaded, setSensitiveLoaded] = useState(false);
  const [sensitiveBusy, setSensitiveBusy] = useState(false);
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [createForPositionId, setCreateForPositionId] = useState<string | null>(null);
  const [positionFormMode, setPositionFormMode] = useState<PositionFormMode>(null);
  const [editingPosition, setEditingPosition] = useState<Position | null>(null);
  const [positionFormBusy, setPositionFormBusy] = useState(false);
  const [positionFormError, setPositionFormError] = useState("");
  const [busyPositionId, setBusyPositionId] = useState<string | null>(null);
  const [positionDetail, setPositionDetail] = useState<Position | null>(null);
  const [positionCandidates, setPositionCandidates] = useState<Candidate[]>([]);
  const [positionCandidatePage, setPositionCandidatePage] = useState(1);
  const [positionCandidatePageSize, setPositionCandidatePageSize] = useState<PageSize>(20);
  const [positionCandidatePagination, setPositionCandidatePagination] = useState<PaginationState>(EMPTY_PAGINATION);
  const [positionDetailLoading, setPositionDetailLoading] = useState(false);
  const [positionDetailError, setPositionDetailError] = useState("");
  const [busyLinkedCandidateId, setBusyLinkedCandidateId] = useState<string | null>(null);
  const [candidatePickerOpen, setCandidatePickerOpen] = useState(false);
  const [candidatePickerBusy, setCandidatePickerBusy] = useState(false);
  const [linkTargetCandidateIds, setLinkTargetCandidateIds] = useState<string[]>([]);
  const [linkTargetPositionId, setLinkTargetPositionId] = useState("");
  const [linkDialogBusy, setLinkDialogBusy] = useState(false);

  const [importOpen, setImportOpen] = useState(hasRecoverableImportTask);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsedPreference);
  const [agentConfigured, setAgentConfigured] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [permanentDeleteRequest, setPermanentDeleteRequest] = useState<PermanentDeleteRequest | null>(null);
  const toastTimer = useRef<number | null>(null);
  const debouncedCandidateSearch = useDebouncedValue(candidateSearch, 220);
  const debouncedPositionSearch = useDebouncedValue(positionSearch, 220);

  const notify = useCallback((message: string, options: Omit<ToastState, "message"> = {}) => {
    setToast({ message, ...options });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), options.action ? 8000 : 3600);
  }, []);

  const toggleDesktopSidebar = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
      } catch {
        return false;
      }
      return next;
    });
  }, []);

  const replaceCandidateLocally = useCallback((candidate: Candidate) => {
    setCandidates((current) => current.map((item) => item.id === candidate.id ? candidate : item));
    setPositionCandidates((current) => current.map((item) => item.id === candidate.id ? candidate : item));
    setCandidateDetail((current) => current?.id === candidate.id
      ? { ...current, ...candidate, notes: current.notes, activities: current.activities }
      : current);
  }, []);

  const markCandidatesArchivedLocally = useCallback((candidateIds: string[]) => {
    const archivedIds = new Set(candidateIds);
    const archivedAt = new Date().toISOString();
    const markArchived = (candidate: Candidate) => archivedIds.has(candidate.id)
      ? { ...candidate, archived_at: candidate.archived_at ?? archivedAt }
      : candidate;
    setCandidates((current) => current.map(markArchived));
    setPositionCandidates((current) => current.map(markArchived));
    setCandidateDetail((current) => current && archivedIds.has(current.id)
      ? { ...current, archived_at: current.archived_at ?? archivedAt }
      : current);
  }, []);

  const removeCandidatesLocally = useCallback((candidateIds: string[]) => {
    const removedIds = new Set(candidateIds);
    setCandidates((current) => current.filter((candidate) => !removedIds.has(candidate.id)));
    setPositionCandidates((current) => current.filter((candidate) => !removedIds.has(candidate.id)));
    setCandidateDetail((current) => current && removedIds.has(current.id) ? null : current);
    setSelectedCandidateIds((current) => {
      const next = new Set(current);
      candidateIds.forEach((id) => next.delete(id));
      return next;
    });
  }, []);

  const removePositionsLocally = useCallback((positionIds: string[]) => {
    const removedIds = new Set(positionIds);
    setPositions((current) => current.filter((position) => !removedIds.has(position.id)));
    setSelectedPositionIds((current) => {
      const next = new Set(current);
      positionIds.forEach((id) => next.delete(id));
      return next;
    });
    if (activePositionId && removedIds.has(activePositionId)) {
      setActivePositionId(null);
      setPositionDetail(null);
      setPositionCandidates([]);
    }
  }, [activePositionId]);

  const loadWorkspace = useCallback(async (showLoading = true) => {
    if (showLoading) setWorkspaceLoading(true);
    setWorkspaceError("");
    try {
      const [nextPositionLookup, nextTalentPools, nextDashboard, nextCandidateFacets, nextPositionFacets] = await Promise.all([
        positionApi.listAll({ archived: "include" }),
        talentPoolApi.listAll({ archived: "include" }),
        getDashboard(),
        candidateApi.facets({ archived: "include" }),
        positionApi.facets({ archived: "include" }),
      ]);
      setPositionLookup(nextPositionLookup);
      setTalentPools(nextTalentPools);
      setDashboard(nextDashboard);
      setCandidateFacets(nextCandidateFacets);
      setPositionFacets(nextPositionFacets);
    } catch (error) {
      setWorkspaceError(errorMessage(error, "工作区数据加载失败"));
    } finally {
      setRefreshVersion((current) => current + 1);
      setWorkspaceLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspace();
    getAgentStatus().then((status) => setAgentConfigured(status.configured)).catch(() => setAgentConfigured(false));
  }, [loadWorkspace]);

  const candidateListFilters = useMemo<CandidateFilters>(() => ({
    search: debouncedCandidateSearch || undefined,
    source: candidateSource === "all" ? undefined : candidateSource,
    owner: candidateOwner === "all" ? undefined : candidateOwner,
    tag: candidateTag === "all" ? undefined : candidateTag,
    position_id: candidatePosition === "all" ? undefined : candidatePosition,
    pool_id: candidatePool === "all" ? undefined : candidatePool,
    education: candidateEducation === "all" ? undefined : candidateEducation,
    school: candidateSchool === "all" ? undefined : candidateSchool,
    gender: candidateGender === "all" ? undefined : candidateGender,
    job_seeking_status: candidateJobStatus === "all" ? undefined : candidateJobStatus,
    archived: candidateArchive === "all" ? "include" : candidateArchive === "archived" ? "only" : "exclude",
    sort: candidateSort === "name_asc" ? "name" : candidateSort === "created_desc" ? "created_at" : candidateSort === "experience_desc" ? "years_experience" : "updated_at",
    order: candidateSort === "name_asc" ? "asc" : "desc",
  }), [candidateArchive, candidateEducation, candidateGender, candidateJobStatus, candidateOwner, candidatePool, candidatePosition, candidateSchool, candidateSort, candidateSource, candidateTag, debouncedCandidateSearch]);

  const positionListFilters = useMemo<PositionFilters>(() => ({
    search: debouncedPositionSearch || undefined,
    status: positionStatus === "all" ? undefined : positionStatus,
    department: positionDepartment === "all" ? undefined : positionDepartment,
    owner: positionOwner === "all" ? undefined : positionOwner,
    location: positionLocation === "all" ? undefined : positionLocation,
    archived: positionArchive === "all" ? "include" : positionArchive === "archived" ? "only" : "exclude",
    sort: positionSort === "title_asc" ? "title" : positionSort === "candidates_desc" ? "candidate_count" : positionSort === "headcount_desc" ? "headcount" : "updated_at",
    order: positionSort === "title_asc" ? "asc" : "desc",
  }), [debouncedPositionSearch, positionArchive, positionDepartment, positionLocation, positionOwner, positionSort, positionStatus]);

  useEffect(() => {
    setCandidatePage(1);
  }, [candidateListFilters, candidatePageSize]);

  useEffect(() => {
    setPositionPage(1);
  }, [positionListFilters, positionPageSize]);

  useEffect(() => {
    const controller = new AbortController();
    setCandidateListLoading(true);
    setCandidateListError("");
    void candidateApi.list({ ...candidateListFilters, page: candidatePage, page_size: candidatePageSize }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        const lastPage = Math.max(1, result.pagination.total_pages);
        if (candidatePage > lastPage) {
          setCandidatePage(lastPage);
          return;
        }
        setCandidates(result.items);
        setCandidatePagination(result.pagination);
      })
      .catch((error) => {
        if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
        setCandidateListError(errorMessage(error, "候选人列表加载失败"));
      })
      .finally(() => { if (!controller.signal.aborted) setCandidateListLoading(false); });
    return () => controller.abort();
  }, [candidateListFilters, candidatePage, candidatePageSize, refreshVersion]);

  useEffect(() => {
    const controller = new AbortController();
    setPositionListLoading(true);
    setPositionListError("");
    void positionApi.list({ ...positionListFilters, page: positionPage, page_size: positionPageSize }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        const lastPage = Math.max(1, result.pagination.total_pages);
        if (positionPage > lastPage) {
          setPositionPage(lastPage);
          return;
        }
        setPositions(result.items);
        setPositionPagination(result.pagination);
      })
      .catch((error) => {
        if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
        setPositions([]);
        setPositionPagination(EMPTY_PAGINATION);
        setPositionListError(errorMessage(error, "职位列表加载失败"));
      })
      .finally(() => { if (!controller.signal.aborted) setPositionListLoading(false); });
    return () => controller.abort();
  }, [positionListFilters, positionPage, positionPageSize, refreshVersion]);

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    if (!exportOpen) return;
    const closeMenu = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest(".menu-wrap")) setExportOpen(false);
    };
    document.addEventListener("pointerdown", closeMenu);
    return () => document.removeEventListener("pointerdown", closeMenu);
  }, [exportOpen]);

  useEffect(() => {
    const overlayOpen = Boolean(
      drawerMode
      || positionFormMode
      || candidatePickerOpen
      || linkTargetCandidateIds.length
      || importOpen
      || assistantOpen
      || confirmAction
      || permanentDeleteRequest,
    );
    document.body.classList.toggle("has-overlay", overlayOpen);
    return () => document.body.classList.remove("has-overlay");
  }, [assistantOpen, candidatePickerOpen, confirmAction, drawerMode, importOpen, linkTargetCandidateIds.length, permanentDeleteRequest, positionFormMode]);

  useEffect(() => {
    const closeTopLayer = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (permanentDeleteRequest && !permanentDeleteRequest.loading && !permanentDeleteRequest.committing) return setPermanentDeleteRequest(null);
      if (confirmAction && !confirmBusy) return setConfirmAction(null);
      if (linkTargetCandidateIds.length && !linkDialogBusy) return setLinkTargetCandidateIds([]);
      if (candidatePickerOpen && !candidatePickerBusy) return setCandidatePickerOpen(false);
      if (positionFormMode && !positionFormBusy) return setPositionFormMode(null);
      if (drawerMode && !candidateBusy) return setDrawerMode(null);
      if (assistantOpen) return setAssistantOpen(false);
      if (exportOpen) return setExportOpen(false);
      if (candidateFiltersOpen) return setCandidateFiltersOpen(false);
      if (positionFiltersOpen) setPositionFiltersOpen(false);
    };
    window.addEventListener("keydown", closeTopLayer);
    return () => window.removeEventListener("keydown", closeTopLayer);
  }, [assistantOpen, candidateBusy, candidateFiltersOpen, candidatePickerBusy, candidatePickerOpen, confirmAction, confirmBusy, drawerMode, exportOpen, linkDialogBusy, linkTargetCandidateIds.length, permanentDeleteRequest, positionFiltersOpen, positionFormBusy, positionFormMode]);

  useEffect(() => {
    const handlePopState = () => {
      const route = initialRoute();
      setPage(route.page);
      setActivePositionId(route.positionId);
      setSidebarOpen(false);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const mobileViewport = window.matchMedia("(max-width: 720px)");
    const collapseMobileCandidateFilters = () => {
      if (page === "candidates" && mobileViewport.matches) setCandidateFiltersOpen(false);
    };

    collapseMobileCandidateFilters();
    mobileViewport.addEventListener("change", collapseMobileCandidateFilters);
    return () => mobileViewport.removeEventListener("change", collapseMobileCandidateFilters);
  }, [page]);

  const loadCandidateDetail = useCallback(async (id: string, includeSensitive = false) => {
    try {
      const detail = await candidateApi.get(id, includeSensitive);
      setCandidateDetail(detail);
      if (!includeSensitive) setCandidates((current) => current.map((item) => item.id === id ? detail : item));
      if (includeSensitive) setSensitiveLoaded(true);
      return true;
    } catch (error) {
      notify(errorMessage(error, "候选人详情加载失败"));
      return false;
    }
  }, [notify]);

  const loadPositionDetail = useCallback(async (id: string, showLoading = true, signal?: AbortSignal) => {
    if (showLoading) {
      setPositionDetailLoading(true);
      setPositionCandidates([]);
    }
    setPositionDetailError("");
    try {
      const [nextPosition, candidateResult] = await Promise.all([
        positionApi.get(id),
        positionApi.candidates(id, {
          archived: "include",
          page: positionCandidatePage,
          page_size: positionCandidatePageSize,
          sort: "updated_at",
          order: "desc",
        }, signal),
      ]);
      if (signal?.aborted) return;
      setPositionDetail(nextPosition);
      const lastPage = Math.max(1, candidateResult.pagination.total_pages);
      if (positionCandidatePage > lastPage) {
        setPositionCandidatePage(lastPage);
        return;
      }
      setPositionCandidates(candidateResult.items);
      setPositionCandidatePagination(candidateResult.pagination);
    } catch (error) {
      if (signal?.aborted || error instanceof DOMException && error.name === "AbortError") return;
      const message = errorMessage(error, "职位工作台加载失败");
      setPositionDetailError(message);
      setPositionCandidates([]);
      setPositionCandidatePagination(EMPTY_PAGINATION);
      notify(message);
    } finally {
      if (!signal?.aborted) setPositionDetailLoading(false);
    }
  }, [notify, positionCandidatePage, positionCandidatePageSize]);

  useEffect(() => {
    if (page !== "position-detail" || !activePositionId) return;
    const controller = new AbortController();
    void loadPositionDetail(activePositionId, true, controller.signal);
    return () => controller.abort();
  }, [activePositionId, loadPositionDetail, page]);

  useEffect(() => {
    setPositionCandidatePage(1);
    setPositionCandidatePagination(EMPTY_PAGINATION);
  }, [activePositionId]);

  const availableSources = candidateFacets.sources;
  const availableCandidateOwners = candidateFacets.owners;
  const availableTags = candidateFacets.tags;
  const availableEducation = candidateFacets.education;
  const availableSchools = candidateFacets.schools;
  const availableGenders = candidateFacets.genders;
  const availableJobStatuses = candidateFacets.job_seeking_statuses;
  const availablePositionOwners = positionFacets.owners;
  const availableDepartments = positionFacets.departments;
  const availableLocations = positionFacets.locations;
  const filteredCandidates = candidates;
  const visiblePositions = positions;

  useEffect(() => setSelectedCandidateIds(new Set()), [candidateArchive, candidateEducation, candidateGender, candidateJobStatus, candidateOwner, candidatePage, candidatePageSize, candidatePool, candidatePosition, candidateSchool, candidateSearch, candidateSource, candidateTag, candidateView]);
  useEffect(() => setSelectedPositionIds(new Set()), [positionArchive, positionDepartment, positionLocation, positionOwner, positionPage, positionPageSize, positionSearch, positionSort, positionStatus]);

  const selectedCandidateKind = useMemo<"active" | "archived" | null>(() => {
    const firstId = selectedCandidateIds.values().next().value as string | undefined;
    if (!firstId) return null;
    return candidates.find((candidate) => candidate.id === firstId)?.archived_at ? "archived" : "active";
  }, [candidates, selectedCandidateIds]);

  const selectedPositionKind = useMemo<"active" | "archived" | null>(() => {
    const firstId = selectedPositionIds.values().next().value as string | undefined;
    if (!firstId) return null;
    return positions.find((position) => position.id === firstId)?.archived_at ? "archived" : "active";
  }, [positions, selectedPositionIds]);

  function toggleCandidateSelection(candidateId: string) {
    const candidate = candidates.find((item) => item.id === candidateId);
    if (!candidate) return;
    const kind = candidate.archived_at ? "archived" : "active";
    if (selectedCandidateKind && selectedCandidateKind !== kind) {
      notify("活动候选人与归档候选人不能混合选择，请先取消当前选择", { tone: "warning" });
      return;
    }
    setSelectedCandidateIds((current) => {
      const next = new Set(current);
      next.has(candidateId) ? next.delete(candidateId) : next.add(candidateId);
      return next;
    });
  }

  function toggleAllCandidateSelection(candidateIds: string[], selected: boolean) {
    if (!selected) {
      setSelectedCandidateIds(new Set());
      return;
    }
    const kind = candidateIds[0] && candidates.find((candidate) => candidate.id === candidateIds[0])?.archived_at ? "archived" : "active";
    const compatibleIds = candidateIds.filter((id) => Boolean(candidates.find((candidate) => candidate.id === id)?.archived_at) === (kind === "archived"));
    setSelectedCandidateIds(new Set(compatibleIds));
  }

  function togglePositionSelection(positionId: string) {
    const position = positions.find((item) => item.id === positionId);
    if (!position) return;
    const kind = position.archived_at ? "archived" : "active";
    if (selectedPositionKind && selectedPositionKind !== kind) {
      notify("活动职位与归档职位不能混合选择，请先取消当前选择", { tone: "warning" });
      return;
    }
    setSelectedPositionIds((current) => {
      const next = new Set(current);
      next.has(positionId) ? next.delete(positionId) : next.add(positionId);
      return next;
    });
  }

  function toggleAllPositionSelection(positionIds: string[], selected: boolean) {
    if (!selected) {
      setSelectedPositionIds(new Set());
      return;
    }
    const kind = positionIds[0] && positions.find((position) => position.id === positionIds[0])?.archived_at ? "archived" : "active";
    const compatibleIds = positionIds.filter((id) => Boolean(positions.find((position) => position.id === id)?.archived_at) === (kind === "archived"));
    setSelectedPositionIds(new Set(compatibleIds));
  }

  function navigate(next: Exclude<Page, "position-detail">, replace = false) {
    const path = next === "dashboard" ? "/" : `/${next}`;
    window.history[replace ? "replaceState" : "pushState"]({}, "", path);
    setPage(next);
    setActivePositionId(null);
    setSidebarOpen(false);
    setExportOpen(false);
  }

  function openPosition(position: Position) {
    window.history.pushState({}, "", `/positions/${encodeURIComponent(position.id)}`);
    setPage("position-detail");
    setActivePositionId(position.id);
    setPositionDetail(position);
    setSidebarOpen(false);
    setDrawerMode(null);
  }

  function openCandidate(candidate: Candidate) {
    setSensitiveLoaded(false);
    setSelectedCandidateId(candidate.id);
    setCandidateDetail(candidate as CandidateDetail);
    setDrawerMode("detail");
    void loadCandidateDetail(candidate.id);
  }

  async function openCandidateById(candidateId: string) {
    setAssistantOpen(false);
    const currentPageCandidate = candidates.find((candidate) => candidate.id === candidateId);
    if (currentPageCandidate) {
      openCandidate(currentPageCandidate);
      return;
    }
    try {
      const detail = await candidateApi.get(candidateId);
      setSensitiveLoaded(false);
      setSelectedCandidateId(candidateId);
      setCandidateDetail(detail);
      setDrawerMode("detail");
    } catch (error) {
      notify(errorMessage(error, "候选人详情加载失败"));
    }
  }

  function editCandidate(candidate: Candidate) {
    if (candidate.archived_at) {
      openCandidate(candidate);
      notify("已归档候选人只能查看或恢复");
      return;
    }
    setSelectedCandidateId(candidate.id);
    setCandidateDetail(candidate as CandidateDetail);
    setDrawerMode("edit");
    setSensitiveLoaded(false);
    setCandidateBusy(true);
    void loadCandidateDetail(candidate.id, true)
      .then((loaded) => { if (!loaded) setDrawerMode("detail"); })
      .finally(() => setCandidateBusy(false));
  }

  function createCandidate(positionId: string | null = null) {
    setSensitiveLoaded(false);
    setSelectedCandidateId(null);
    setCandidateDetail(null);
    setCreateForPositionId(positionId);
    setDrawerMode("create");
  }

  async function saveCandidate(draft: CandidateDraft) {
    setCandidateBusy(true);
    try {
      const { preferences, stage: _legacyStage, expected_salary: _legacySalary, ...candidateFields } = draft;
      if (drawerMode === "create") {
        let linkedToRequestedPosition = false;
        const created = await candidateApi.create({
          ...candidateFields,
          source_system: "manual",
          source_record_id: crypto.randomUUID(),
        });
        await candidateApi.updatePreferences(created.id, preferences);
        if (createForPositionId) {
          try {
            await positionApi.linkCandidates(createForPositionId, [created.id]);
            linkedToRequestedPosition = true;
          } catch (linkError) {
            notify(errorMessage(linkError, "候选人已创建，但自动关联职位失败"));
          }
        }
        setSelectedCandidateId(created.id);
        setDrawerMode("detail");
        setCreateForPositionId(null);
        await Promise.all([loadCandidateDetail(created.id, true), loadWorkspace(false)]);
        if (activePositionId) await loadPositionDetail(activePositionId, false);
        if (!createForPositionId || linkedToRequestedPosition) {
          notify(linkedToRequestedPosition ? "候选人已创建并关联当前职位" : "候选人档案已创建");
        }
      } else if (selectedCandidateId) {
        const existingCandidate = candidates.find((candidate) => candidate.id === selectedCandidateId);
        if (existingCandidate?.archived_at) {
          setDrawerMode("detail");
          notify("已归档候选人不能编辑，请先恢复候选人");
          return;
        }
        const updated = await candidateApi.update(selectedCandidateId, candidateFields);
        await candidateApi.updatePreferences(selectedCandidateId, preferences);
        setCandidateDetail((current) => current ? { ...current, ...updated } : updated as CandidateDetail);
        setDrawerMode("detail");
        await Promise.all([loadCandidateDetail(updated.id, true), loadWorkspace(false)]);
        if (activePositionId) await loadPositionDetail(activePositionId, false);
        notify("候选人信息已更新");
      }
    } catch (error) {
      notify(errorMessage(error, "候选人保存失败"));
    } finally {
      setCandidateBusy(false);
    }
  }

  async function archiveCandidate(candidate: Candidate) {
    if (candidate.archived_at) {
      notify("该候选人已经归档");
      return;
    }
    setCandidateBusy(true);
    try {
      const archivedCandidate = await candidateApi.archive(candidate.id);
      replaceCandidateLocally(archivedCandidate);
      setDrawerMode(null);
      setSelectedCandidateIds((current) => { const next = new Set(current); next.delete(candidate.id); return next; });
      await loadWorkspace(false);
      if (activePositionId) await loadPositionDetail(activePositionId, false);
      notify("候选人已移入归档", {
        actionLabel: "撤销",
        action: async () => {
          const restoredCandidate = await candidateApi.restore(candidate.id);
          replaceCandidateLocally(restoredCandidate);
          await loadWorkspace(false);
          if (activePositionId) await loadPositionDetail(activePositionId, false);
          notify("已撤销归档");
        },
      });
    } catch (error) {
      notify(errorMessage(error, "候选人归档失败"), { tone: "warning" });
    } finally {
      setCandidateBusy(false);
    }
  }

  function requestBulkArchive() {
    const candidateIds = [...selectedCandidateIds].filter((id) => {
      const candidate = candidates.find((item) => item.id === id);
      return candidate && !candidate.archived_at;
    });
    if (!candidateIds.length) return;
    if (candidateIds.length > 100) {
      notify("单次最多归档 100 位候选人，请缩小选择范围", { tone: "warning" });
      return;
    }
    setConfirmAction({
      title: "批量归档候选人",
      message: `确认将选中的 ${candidateIds.length} 位候选人移入归档？候选人资料和全部关系都会保留，可逐一恢复。`,
      confirmLabel: `归档 ${candidateIds.length} 人`,
      tone: "danger",
      run: async () => {
        try {
          const result = await candidateApi.archiveMany(candidateIds);
          markCandidatesArchivedLocally(result.archived_ids);
          setSelectedCandidateIds(new Set());
          await loadWorkspace(false);
          if (activePositionId) await loadPositionDetail(activePositionId, false);
          notify(`已归档 ${result.archived_count} 位候选人`);
        } catch (error) {
          if (error instanceof ApiError && [404, 409].includes(error.status)) {
            setSelectedCandidateIds(new Set());
            await loadWorkspace(false);
            if (activePositionId) await loadPositionDetail(activePositionId, false);
            notify("候选人状态已发生变化，列表已刷新，请重新选择后归档", { tone: "warning" });
            return;
          }
          throw error;
        }
      },
    });
  }

  async function restoreCandidate(candidate: Candidate) {
    setCandidateBusy(true);
    try {
      const restoredCandidate = await candidateApi.restore(candidate.id);
      replaceCandidateLocally(restoredCandidate);
      setDrawerMode(null);
      await loadWorkspace(false);
      if (activePositionId) await loadPositionDetail(activePositionId, false);
      notify("候选人已恢复到候选人库");
    } catch (error) {
      notify(errorMessage(error, "候选人恢复失败"));
    } finally {
      setCandidateBusy(false);
    }
  }

  function requestPermanentDelete(candidate: Candidate) {
    if (!candidate.archived_at) {
      notify("只有已归档候选人可以永久删除", { tone: "warning" });
      return;
    }
    void requestPermanentDeletePreview("candidate", [candidate.id]);
  }

  function requestBulkPermanentDeleteCandidates() {
    const ids = [...selectedCandidateIds];
    const selected = ids.map((id) => candidates.find((candidate) => candidate.id === id)).filter((candidate): candidate is Candidate => Boolean(candidate));
    if (!selected.length) return;
    if (selected.some((candidate) => !candidate.archived_at)) {
      notify("活动候选人与归档候选人不能混合执行永久删除", { tone: "warning" });
      return;
    }
    void requestPermanentDeletePreview("candidate", ids);
  }

  async function requestPermanentDeletePreview(entity: PermanentDeleteEntity, ids: string[]) {
    if (!ids.length) return;
    if (ids.length > 100) {
      notify(`单次最多永久删除 100 ${entity === "candidate" ? "位候选人" : "个职位"}`, { tone: "warning" });
      return;
    }
    const request: PermanentDeleteRequest = { entity, ids, preview: null, loading: true, committing: false, error: "" };
    setPermanentDeleteRequest(request);
    try {
      const preview = entity === "candidate"
        ? await candidateApi.previewPermanentDelete(ids)
        : await positionApi.previewPermanentDelete(ids);
      setPermanentDeleteRequest((current) => current && current.entity === entity && current.ids.join(",") === ids.join(",")
        ? { ...current, preview, loading: false, error: "" }
        : current);
    } catch (error) {
      const message = errorMessage(error, "删除预览生成失败");
      setPermanentDeleteRequest((current) => current ? { ...current, loading: false, error: message } : current);
      if (error instanceof ApiError && [404, 409].includes(error.status)) await loadWorkspace(false);
    }
  }

  async function commitPermanentDelete() {
    const request = permanentDeleteRequest;
    if (!request?.preview || request.loading || request.committing) return;
    setPermanentDeleteRequest({ ...request, committing: true, error: "" });
    try {
      if (request.entity === "candidate") {
        await candidateApi.commitPermanentDelete(request.preview.preview_token);
        removeCandidatesLocally(request.ids);
        if (request.ids.includes(selectedCandidateId ?? "")) {
          setDrawerMode(null);
          setSelectedCandidateId(null);
        }
      } else {
        await positionApi.commitPermanentDelete(request.preview.preview_token);
        removePositionsLocally(request.ids);
        if (request.ids.includes(activePositionId ?? "")) navigate("positions");
      }
      setPermanentDeleteRequest(null);
      await loadWorkspace(false);
      if (activePositionId && !request.ids.includes(activePositionId)) await loadPositionDetail(activePositionId, false);
      notify(`${request.entity === "candidate" ? "候选人" : "职位"}已永久删除，应用内无法恢复`);
    } catch (error) {
      const conflict = error instanceof ApiError && [404, 409].includes(error.status);
      setPermanentDeleteRequest((current) => current ? { ...current, committing: false, preview: conflict ? null : current.preview, error: conflict ? "数据状态或版本已经变化，请重新生成删除预览。" : errorMessage(error, "永久删除失败") } : current);
      if (conflict) await loadWorkspace(false);
    }
  }

  async function addNote(content: string) {
    if (!selectedCandidateId) return;
    const candidate = candidates.find((item) => item.id === selectedCandidateId);
    if (candidate?.archived_at) {
      notify("已归档候选人不能添加备注，请先恢复候选人");
      return;
    }
    setCandidateBusy(true);
    try {
      await candidateApi.addNote(selectedCandidateId, content);
      await loadCandidateDetail(selectedCandidateId, sensitiveLoaded);
      notify("备注已添加");
    } catch (error) {
      notify(errorMessage(error, "备注添加失败"));
    } finally {
      setCandidateBusy(false);
    }
  }

  async function revealCandidateSensitive() {
    if (!selectedCandidateId || sensitiveBusy) return;
    setSensitiveBusy(true);
    try {
      await loadCandidateDetail(selectedCandidateId, true);
    } finally {
      setSensitiveBusy(false);
    }
  }

  async function linkCandidateToTalentPool(poolId: string) {
    if (!selectedCandidateId) return;
    setCandidateBusy(true);
    try {
      const result = await talentPoolApi.linkCandidates(poolId, [selectedCandidateId]);
      await Promise.all([loadCandidateDetail(selectedCandidateId, sensitiveLoaded), loadWorkspace(false)]);
      notify(result.linked_count ? "已加入人才库" : "候选人已在该人才库中");
    } catch (error) {
      notify(errorMessage(error, "加入人才库失败"));
    } finally {
      setCandidateBusy(false);
    }
  }

  async function unlinkCandidateFromTalentPool(poolId: string) {
    if (!selectedCandidateId) return;
    setCandidateBusy(true);
    try {
      await talentPoolApi.unlinkCandidates(poolId, [selectedCandidateId]);
      await Promise.all([loadCandidateDetail(selectedCandidateId, sensitiveLoaded), loadWorkspace(false)]);
      notify("已从人才库移出，候选人档案仍保留");
    } catch (error) {
      notify(errorMessage(error, "移出人才库失败"));
    } finally {
      setCandidateBusy(false);
    }
  }

  async function linkCandidateToPosition(positionId: string) {
    if (!selectedCandidateId) return;
    const candidate = candidates.find((item) => item.id === selectedCandidateId);
    if (candidate?.archived_at) {
      notify("已归档候选人不能关联职位，请先恢复候选人");
      return;
    }
    setCandidateBusy(true);
    try {
      const result = await positionApi.linkCandidates(positionId, [selectedCandidateId]);
      await Promise.all([loadCandidateDetail(selectedCandidateId, sensitiveLoaded), loadWorkspace(false)]);
      if (activePositionId) await loadPositionDetail(activePositionId, false);
      notify(result.linked_count ? "已关联招聘职位" : "候选人已关联该职位");
    } catch (error) {
      notify(errorMessage(error, "职位关联失败"));
    } finally {
      setCandidateBusy(false);
    }
  }

  async function unlinkCandidateFromPosition(positionId: string) {
    if (!selectedCandidateId) return;
    const candidate = candidates.find((item) => item.id === selectedCandidateId);
    if (candidate?.archived_at) {
      notify("已归档候选人不能解除职位关联，请先恢复候选人");
      return;
    }
    setCandidateBusy(true);
    try {
      await positionApi.unlinkCandidate(positionId, selectedCandidateId);
      await Promise.all([loadCandidateDetail(selectedCandidateId, sensitiveLoaded), loadWorkspace(false)]);
      if (activePositionId) await loadPositionDetail(activePositionId, false);
      notify("已解除职位关联，候选人档案仍保留");
    } catch (error) {
      notify(errorMessage(error, "解除关联失败"));
    } finally {
      setCandidateBusy(false);
    }
  }

  function openBulkLink(candidateIds: string[]) {
    const activeIds = candidateIds.filter((id) => {
      const candidate = candidates.find((item) => item.id === id);
      return candidate && !candidate.archived_at;
    });
    if (!activeIds.length) {
      if (candidateIds.length) notify("已归档候选人不能关联职位，请先恢复候选人");
      return;
    }
    if (activeIds.length > 100) {
      notify("单次最多关联 100 位候选人，请缩小选择范围");
      return;
    }
    setLinkTargetCandidateIds(activeIds);
    setLinkTargetPositionId(positions.find((position) => !position.archived_at && position.status !== "closed")?.id ?? "");
  }

  async function confirmBulkLink() {
    if (!linkTargetPositionId || !linkTargetCandidateIds.length) return;
    const activeIds = linkTargetCandidateIds.filter((id) => {
      const candidate = candidates.find((item) => item.id === id);
      return candidate && !candidate.archived_at;
    });
    if (!activeIds.length) {
      setLinkTargetCandidateIds([]);
      notify("所选候选人均已归档，未执行职位关联");
      return;
    }
    setLinkDialogBusy(true);
    try {
      const result = await positionApi.linkCandidates(linkTargetPositionId, activeIds);
      await loadWorkspace(false);
      setLinkTargetCandidateIds([]);
      setSelectedCandidateIds(new Set());
      notify(`已关联 ${result.linked_count} 位候选人${result.existing_count ? `，${result.existing_count} 位原已关联` : ""}`);
    } catch (error) {
      notify(errorMessage(error, "批量关联失败"));
    } finally {
      setLinkDialogBusy(false);
    }
  }

  function openPositionForm(mode: Exclude<PositionFormMode, null>, position?: Position) {
    setEditingPosition(position ?? null);
    setPositionFormMode(mode);
    setPositionFormError("");
  }

  async function savePosition(draft: PositionDraft) {
    setPositionFormBusy(true);
    setPositionFormError("");
    try {
      const saved = positionFormMode === "edit" && editingPosition
        ? await positionApi.update(editingPosition.id, draft)
        : await positionApi.create(draft);
      setPositionFormMode(null);
      setEditingPosition(null);
      await loadWorkspace(false);
      if (page === "position-detail") {
        setActivePositionId(saved.id);
        await loadPositionDetail(saved.id, false);
      }
      notify(positionFormMode === "edit" ? "职位信息已更新" : "职位已创建");
    } catch (error) {
      setPositionFormError(errorMessage(error, "职位保存失败"));
    } finally {
      setPositionFormBusy(false);
    }
  }

  function requestArchivePosition(position: Position) {
    setConfirmAction({
      title: "归档职位",
      message: `“${position.title}”将从默认列表隐藏，${position.candidate_count} 位关联候选人不会被删除。`,
      confirmLabel: "确认归档",
      tone: "danger",
      run: async () => {
        setBusyPositionId(position.id);
        try {
          await positionApi.archive(position.id);
          await loadWorkspace(false);
          setSelectedPositionIds((current) => {
            const next = new Set(current);
            next.delete(position.id);
            return next;
          });
          if (activePositionId === position.id) await loadPositionDetail(position.id, false);
          notify("职位已归档");
        } finally {
          setBusyPositionId(null);
        }
      },
    });
  }

  function requestBulkArchivePositions() {
    const selected = [...selectedPositionIds]
      .map((id) => positions.find((position) => position.id === id));
    if (selected.some((position) => !position || position.archived_at)) {
      setSelectedPositionIds(new Set());
      void loadWorkspace(false);
      notify("所选职位状态已变化，请刷新后重新选择", { tone: "warning" });
      return;
    }
    const activePositions = selected as Position[];
    if (!activePositions.length) return;
    if (activePositions.length > 100) {
      notify("单次最多归档 100 个职位，请缩小选择范围", { tone: "warning" });
      return;
    }
    const linkedCandidateCount = activePositions.reduce((sum, position) => sum + position.candidate_count, 0);
    setConfirmAction({
      title: `归档 ${activePositions.length} 个职位`,
      message: `选中的职位将从默认列表隐藏，可在“已归档”中恢复。${linkedCandidateCount} 条候选人职位关系会保留，不会删除任何候选人档案。`,
      confirmLabel: "确认批量归档",
      tone: "danger",
      run: async () => {
        const result = await positionApi.archiveBatch(activePositions.map((position) => ({
          id: position.id,
          expected_updated_at: position.updated_at,
        })));
        await loadWorkspace(false);
        setSelectedPositionIds(new Set());
        notify(`已归档 ${result.updated_count} 个职位`);
      },
    });
  }

  async function restorePosition(position: Position) {
    setBusyPositionId(position.id);
    try {
      await positionApi.restore(position.id);
      await loadWorkspace(false);
      setSelectedPositionIds((current) => {
        const next = new Set(current);
        next.delete(position.id);
        return next;
      });
      if (activePositionId === position.id) await loadPositionDetail(position.id, false);
      notify("职位已恢复");
    } catch (error) {
      notify(errorMessage(error, "职位恢复失败"));
    } finally {
      setBusyPositionId(null);
    }
  }

  function requestPermanentDeletePosition(position: Position) {
    if (!position.archived_at) {
      notify("只有已归档职位可以永久删除", { tone: "warning" });
      return;
    }
    void requestPermanentDeletePreview("position", [position.id]);
  }

  function requestBulkPermanentDeletePositions() {
    const ids = [...selectedPositionIds];
    if (!ids.length) return;
    if (ids.length > 100) {
      notify("单次最多永久删除 100 个职位，请缩小选择范围", { tone: "warning" });
      return;
    }
    void requestPermanentDeletePreview("position", ids);
  }

  async function addCandidatesToActivePosition(candidateIds: string[]) {
    if (!activePositionId) return;
    setCandidatePickerBusy(true);
    try {
      const result = await positionApi.linkCandidates(activePositionId, candidateIds);
      setCandidatePickerOpen(false);
      await Promise.all([loadPositionDetail(activePositionId, false), loadWorkspace(false)]);
      notify(`已添加 ${result.linked_count} 位候选人`);
    } catch (error) {
      notify(errorMessage(error, "添加候选人失败"));
    } finally {
      setCandidatePickerBusy(false);
    }
  }

  async function unlinkFromActivePosition(position: Position, candidate: Candidate) {
    if (candidate.archived_at) {
      notify("已归档候选人只能查看或恢复");
      return;
    }
    setBusyLinkedCandidateId(candidate.id);
    try {
      await positionApi.unlinkCandidate(position.id, candidate.id);
      await Promise.all([loadPositionDetail(position.id, false), loadWorkspace(false)]);
      notify("已从当前职位解除关联");
    } catch (error) {
      notify(errorMessage(error, "解除关联失败"));
    } finally {
      setBusyLinkedCandidateId(null);
    }
  }

  async function bulkUnlinkFromActivePosition(position: Position, candidateIds: string[]) {
    const activeIds = candidateIds.filter((id) => {
      const candidate = positionCandidates.find((item) => item.id === id);
      return candidate && !candidate.archived_at;
    });
    if (!activeIds.length) return;
    setPositionDetailLoading(true);
    try {
      const result = await positionApi.unlinkCandidates(position.id, activeIds);
      await Promise.all([loadPositionDetail(position.id, false), loadWorkspace(false)]);
      notify(`已解除 ${result.removed_count} 条职位关联${result.absent_count ? `，${result.absent_count} 条原本未关联` : ""}`);
    } catch (error) {
      notify(errorMessage(error, "批量解除关联失败，未修改任何关系"));
    } finally {
      setPositionDetailLoading(false);
    }
  }

  function exportCandidates(format: "xlsx" | "csv", positionId?: string) {
    if (positionId) {
      const anchor = document.createElement("a");
      anchor.href = candidateExportUrl(format, {
        position_id: positionId,
        archived: "include",
      });
      anchor.click();
      notify("当前职位候选人导出文件正在生成");
      return;
    }

    const archived = candidateArchive === "all" ? "include" : candidateArchive === "archived" ? "only" : "exclude";
    const url = candidateExportUrl(format, {
      search: candidateSearch.trim() || undefined,
      source: candidateSource === "all" ? undefined : candidateSource,
      owner: candidateOwner === "all" ? undefined : candidateOwner,
      tag: candidateTag === "all" ? undefined : candidateTag,
      position_id: positionId ?? (candidatePosition === "all" ? undefined : candidatePosition),
      pool_id: candidatePool === "all" ? undefined : candidatePool,
      education: candidateEducation === "all" ? undefined : candidateEducation,
      school: candidateSchool === "all" ? undefined : candidateSchool,
      gender: candidateGender === "all" ? undefined : candidateGender,
      job_seeking_status: candidateJobStatus === "all" ? undefined : candidateJobStatus,
      archived,
      sort: candidateSort === "name_asc" ? "name" : candidateSort === "created_desc" ? "created_at" : candidateSort === "experience_desc" ? "years_experience" : "updated_at",
      order: candidateSort === "name_asc" ? "asc" : "desc",
    });
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.click();
    setExportOpen(false);
    notify("导出文件正在生成");
  }

  function clearCandidateFilters() {
    setCandidateSearch("");
    setCandidateSource("all");
    setCandidateOwner("all");
    setCandidateTag("all");
    setCandidatePosition("all");
    setCandidatePool("all");
    setCandidateEducation("all");
    setCandidateSchool("all");
    setCandidateGender("all");
    setCandidateJobStatus("all");
    setCandidateArchive("active");
  }

  function clearPositionFilters() {
    setPositionSearch("");
    setPositionStatus("all");
    setPositionDepartment("all");
    setPositionOwner("all");
    setPositionLocation("all");
    setPositionArchive("active");
  }

  function openUngroupedCandidates() {
    clearCandidateFilters();
    setCandidatePool("unassigned");
    setCandidateView("list");
    navigate("candidates");
  }

  const candidateFilterCount = [candidateSource, candidateOwner, candidateTag, candidatePosition, candidatePool, candidateEducation, candidateSchool, candidateGender, candidateJobStatus]
    .filter((value) => value !== "all").length + (candidateArchive !== "active" ? 1 : 0);
  const positionFilterCount = [positionStatus, positionDepartment, positionOwner, positionLocation]
    .filter((value) => value !== "all").length + (positionArchive !== "active" ? 1 : 0);

  const currentCandidate = candidateDetail ?? candidates.find((candidate) => candidate.id === selectedCandidateId) ?? null;
  const activePositionOptions = positionLookup.filter((position) => !position.archived_at && position.status !== "closed");
  const title = page === "position-detail" ? positionDetail?.title ?? "职位详情" : pageMeta[page].label;
  const activeCandidateTotal = candidateFacets.totals.active;
  const archivedCandidateTotal = candidateFacets.totals.archived;
  const candidateScopeLabel = candidateArchive === "archived"
    ? "位已归档候选人"
    : candidateArchive === "all"
      ? "位候选人（含归档）"
      : "位在库候选人";

  return (
    <div className={`app-shell${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}>
      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <div className="brand">
          <span className="brand-mark" title={sidebarCollapsed ? "拾才工作台" : undefined}><Sparkles size={19} /></span>
          <div><strong>拾才工作台</strong><small>Talent Workspace</small></div>
        </div>
        <nav className="primary-nav" aria-label="主导航">
          {(Object.entries(pageMeta) as Array<[Exclude<Page, "position-detail">, typeof pageMeta.dashboard]>).map(([id, item]) => {
            const Icon = item.icon;
            const active = page === id || (id === "positions" && page === "position-detail");
            return <button className={active ? "active" : ""} type="button" key={id} onClick={() => navigate(id)} aria-label={item.label} title={sidebarCollapsed ? item.label : undefined}><Icon size={18} /><span>{item.label}</span></button>;
          })}
          <span className="nav-divider" />
          <button type="button" onClick={() => { setImportOpen(true); setSidebarOpen(false); }} aria-label="数据导入" title={sidebarCollapsed ? "数据导入" : undefined}><Upload size={18} /><span>数据导入</span></button>
          <button type="button" onClick={() => { setAssistantOpen(true); setSidebarOpen(false); }} aria-label="AI 助手" title={sidebarCollapsed ? `AI 助手（${agentConfigured ? "在线" : "未配置"}）` : undefined}><Bot size={18} /><span>AI 助手</span><small className={`nav-status-dot ${agentConfigured ? "is-online" : ""}`} /></button>
        </nav>
        <div className="sidebar-context" title={sidebarCollapsed ? "本地工作区：数据仅保存在本机" : undefined}>
          <span className="context-icon"><Check size={14} /></span>
          <div><strong>本地工作区</strong><small>数据仅保存在本机</small></div>
          <button
            className="icon-button compact-icon-button sidebar-collapse-button"
            type="button"
            onClick={toggleDesktopSidebar}
            aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <button
            className="icon-button mobile-menu-button"
            type="button"
            onClick={() => setSidebarOpen((current) => !current)}
            aria-label={sidebarOpen ? "关闭导航" : "打开导航"}
            aria-expanded={sidebarOpen}
            title={sidebarOpen ? "关闭导航" : "打开导航"}
          >
            {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className="topbar-title"><strong>{title}</strong><span>{page === "position-detail" ? "职位工作台" : "人才资料管理"}</span></div>
          <div className="topbar-spacer" />
          <button className="agent-entry" type="button" onClick={() => setAssistantOpen(true)}>
            <span className="agent-entry-icon"><Bot size={16} /></span><span>AI 助手</span><small>{agentConfigured ? "全量只读" : "未配置"}</small>
          </button>
        </header>

        <main className="content">
          {workspaceError && (
            <div className="workspace-error" role="alert"><span>{workspaceError}</span><button className="button secondary-button" type="button" onClick={() => void loadWorkspace()}>重新加载</button></div>
          )}

          {page === "dashboard" && (
            <Overview
              data={dashboard}
              loading={workspaceLoading}
              onOpenCandidate={openCandidate}
              onOpenPosition={openPosition}
              onOpenCandidates={() => navigate("candidates")}
              onOpenUngroupedCandidates={openUngroupedCandidates}
              onOpenPositions={() => navigate("positions")}
              onOpenTalentPools={() => navigate("talent-pools")}
              onCreateCandidate={() => createCandidate()}
              onCreatePosition={() => openPositionForm("create")}
              onImport={() => setImportOpen(true)}
            />
          )}

          {page === "talent-pools" && (
            <TalentPoolPage
              onRefresh={() => loadWorkspace(false)}
              onOpenCandidate={openCandidate}
              onEditCandidate={editCandidate}
              onArchiveCandidate={archiveCandidate}
              onRestoreCandidate={restoreCandidate}
              onNotify={notify}
            />
          )}

          {page === "candidates" && (
            <section className="candidate-page">
              <header className="page-heading candidate-page-heading">
                <div><p className="eyebrow">人才资产</p><h1>候选人库</h1><p className="page-description">当前 {filteredCandidates.length} / 共 {candidatePagination.total} {candidateScopeLabel}</p></div>
                <div className="page-actions">
                  <button className="button secondary-button desktop-action" type="button" onClick={() => setImportOpen(true)}><Upload size={16} />导入</button>
                  <div className="menu-wrap">
                    <button className="button secondary-button" type="button" onClick={() => setExportOpen((current) => !current)} aria-expanded={exportOpen}><Download size={16} /><span className="desktop-action-label">导出</span><ChevronDown size={14} /></button>
                    {exportOpen && <ExportMenu count={candidatePagination.total} onExport={exportCandidates} />}
                  </div>
                  <button className="button primary-button" type="button" onClick={() => createCandidate()}><Plus size={17} />新增候选人</button>
                </div>
              </header>

              <div className="candidate-scope-tabs" aria-label="候选人档案范围">
                <button className={candidateArchive === "active" ? "active" : ""} type="button" onClick={() => setCandidateArchive("active")}><span>在库候选人</span><strong>{activeCandidateTotal}</strong></button>
                <button className={candidateArchive === "archived" ? "active" : ""} type="button" onClick={() => { setCandidateArchive("archived"); setCandidateView("list"); }}><span>已归档</span><strong>{archivedCandidateTotal}</strong></button>
                <button className={candidateArchive === "all" ? "active" : ""} type="button" onClick={() => setCandidateArchive("all")}><span>全部档案</span><strong>{candidateFacets.totals.total}</strong></button>
              </div>

              <div className="workspace-toolbar candidate-toolbar">
                <label className="workspace-search"><Search size={17} /><input value={candidateSearch} onChange={(event) => setCandidateSearch(event.target.value)} placeholder="搜索姓名、公司、职位、学校或标签" />{candidateSearch && <button type="button" onClick={() => setCandidateSearch("")} aria-label="清除搜索" title="清除"><X size={15} /></button>}</label>
                <button className={`button filter-toggle ${candidateFiltersOpen || candidateFilterCount ? "is-active" : ""}`} type="button" onClick={() => setCandidateFiltersOpen((current) => !current)}><Filter size={16} />筛选{candidateFilterCount ? <span>{candidateFilterCount}</span> : null}</button>
                <div className="toolbar-spacer" />
                <label className="compact-select"><span className="sr-only">排序方式</span><select value={candidateSort} onChange={(event) => setCandidateSort(event.target.value)}><option value="updated_desc">最近更新</option><option value="created_desc">最近创建</option><option value="name_asc">姓名 A-Z</option><option value="experience_desc">工作年限</option></select></label>
                <div className="segmented-control" aria-label="候选人视图">
                  <button className={candidateView === "list" ? "active" : ""} type="button" onClick={() => setCandidateView("list")} title="列表视图"><List size={16} /><span>列表</span></button>
                  <button className={candidateView === "grouped" ? "active" : ""} type="button" onClick={() => setCandidateView("grouped")} title="按职位分组"><BriefcaseBusiness size={16} /><span>按职位</span></button>
                </div>
              </div>

              <div className={`filter-panel ${candidateFiltersOpen ? "is-open" : ""}`}>
                <label><span>人才库</span><select value={candidatePool} onChange={(event) => setCandidatePool(event.target.value)}><option value="all">全部人才库</option><option value="unassigned">未加入人才库</option>{talentPools.map((pool) => <option value={pool.id} key={pool.id}>{pool.name}{pool.archived_at ? "（已归档）" : ""}</option>)}</select></label>
                <label><span>关联职位</span><select value={candidatePosition} onChange={(event) => setCandidatePosition(event.target.value)}><option value="all">全部职位</option><option value="unassigned">未分配职位</option>{positionLookup.map((position) => <option value={position.id} key={position.id}>{position.title}{position.archived_at ? "（已归档）" : ""}</option>)}</select></label>
                <label><span>最高学历</span><select value={candidateEducation} onChange={(event) => setCandidateEducation(event.target.value)}><option value="all">全部学历</option>{availableEducation.map((value) => <option key={value}>{value}</option>)}</select></label>
                <label><span>学校</span><select value={candidateSchool} onChange={(event) => setCandidateSchool(event.target.value)}><option value="all">全部学校</option>{availableSchools.map((value) => <option key={value}>{value}</option>)}</select></label>
                <label><span>性别</span><select value={candidateGender} onChange={(event) => setCandidateGender(event.target.value)}><option value="all">全部性别</option>{availableGenders.map((value) => <option key={value}>{value}</option>)}</select></label>
                <label><span>求职状态</span><select value={candidateJobStatus} onChange={(event) => setCandidateJobStatus(event.target.value)}><option value="all">全部状态</option>{availableJobStatuses.map((value) => <option key={value}>{value}</option>)}</select></label>
                <label><span>来源</span><select value={candidateSource} onChange={(event) => setCandidateSource(event.target.value)}><option value="all">全部来源</option>{availableSources.map((source) => <option key={source}>{source}</option>)}</select></label>
                <label><span>负责人</span><select value={candidateOwner} onChange={(event) => setCandidateOwner(event.target.value)}><option value="all">全部负责人</option>{availableCandidateOwners.map((owner) => <option key={owner}>{owner}</option>)}</select></label>
                <label><span>标签</span><select value={candidateTag} onChange={(event) => setCandidateTag(event.target.value)}><option value="all">全部标签</option>{availableTags.map((tag) => <option key={tag}>{tag}</option>)}</select></label>
                <label><span>档案状态</span><select value={candidateArchive} onChange={(event) => { const value = event.target.value as ArchiveFilter; setCandidateArchive(value); if (value === "archived") setCandidateView("list"); }}><option value="active">在库候选人</option><option value="archived">已归档</option><option value="all">全部档案</option></select></label>
              </div>

              <ActiveCandidateFilters
                search={candidateSearch}
                source={candidateSource}
                owner={candidateOwner}
                tag={candidateTag}
                positionId={candidatePosition}
                poolId={candidatePool}
                education={candidateEducation}
                school={candidateSchool}
                gender={candidateGender}
                jobStatus={candidateJobStatus}
                archive={candidateArchive}
                positions={positionLookup}
                talentPools={talentPools}
                onClearSearch={() => setCandidateSearch("")}
                onClearSource={() => setCandidateSource("all")}
                onClearOwner={() => setCandidateOwner("all")}
                onClearTag={() => setCandidateTag("all")}
                onClearPosition={() => setCandidatePosition("all")}
                onClearPool={() => setCandidatePool("all")}
                onClearEducation={() => setCandidateEducation("all")}
                onClearSchool={() => setCandidateSchool("all")}
                onClearGender={() => setCandidateGender("all")}
                onClearJobStatus={() => setCandidateJobStatus("all")}
                onClearArchive={() => setCandidateArchive("active")}
                onClearAll={clearCandidateFilters}
              />

              {candidateListError && <div className="workspace-error candidate-filter-error" role="alert"><span>{candidateListError}</span><button className="button secondary-button" type="button" onClick={() => setRefreshVersion((value) => value + 1)}>重新加载</button></div>}

              {selectedCandidateIds.size > 0 && (
                <div className="bulk-action-bar"><span><Check size={16} />已选择 {selectedCandidateIds.size} 位{selectedCandidateKind === "archived" ? "已归档" : "活动"}候选人</span><div><button className="button secondary-button" type="button" onClick={() => setSelectedCandidateIds(new Set())}>取消选择</button>{selectedCandidateKind === "archived" ? <button className="button danger-button" type="button" onClick={requestBulkPermanentDeleteCandidates}><Trash2 size={16} />批量永久删除</button> : <><button className="button danger-quiet-button" type="button" onClick={requestBulkArchive}><Archive size={16} />批量归档</button><button className="button primary-button" type="button" onClick={() => openBulkLink([...selectedCandidateIds])}><BriefcaseBusiness size={16} />关联职位</button></>}</div></div>
              )}

              <div className="candidate-list-region" aria-busy={candidateListLoading}>
                {candidateListLoading && candidates.length === 0 ? <CandidateListSkeleton /> : candidateView === "grouped" ? (
                  <CandidateGroupedView candidates={filteredCandidates} archived={candidateArchive === "archived"} selectedIds={selectedCandidateIds} selectionKind={selectedCandidateKind} onToggle={toggleCandidateSelection} onOpen={openCandidate} onEdit={editCandidate} onArchive={(candidate) => void archiveCandidate(candidate)} onRestore={(candidate) => void restoreCandidate(candidate)} onLinkPositions={openBulkLink} onOpenPosition={openPosition} />
                ) : (
                  <CandidateTable candidates={filteredCandidates} archived={candidateArchive === "archived"} selectedIds={selectedCandidateIds} selectionKind={selectedCandidateKind} onToggle={toggleCandidateSelection} onToggleAll={toggleAllCandidateSelection} onLinkPositions={openBulkLink} onOpen={openCandidate} onEdit={editCandidate} onArchive={(candidate) => void archiveCandidate(candidate)} onRestore={(candidate) => void restoreCandidate(candidate)} onDelete={requestPermanentDelete} />
                )}
              </div>
              <Pagination pagination={candidatePagination} pageSize={candidatePageSize} entityLabel="位候选人" loading={candidateListLoading} onPageChange={setCandidatePage} onPageSizeChange={setCandidatePageSize} />
            </section>
          )}

          {page === "positions" && (
            <section className="positions-page">
              <header className="page-heading">
                <div><p className="eyebrow">招聘职位</p><h1>职位管理</h1><p className="page-description">把候选人按真实招聘职位归类和维护</p></div>
                <button className="button primary-button" type="button" onClick={() => openPositionForm("create")}><Plus size={17} />新增职位</button>
              </header>

              <div className="position-summary-strip" aria-label="职位状态统计">
                <button className={positionStatus === "all" && positionArchive === "active" ? "active" : ""} type="button" onClick={() => { setPositionStatus("all"); setPositionArchive("active"); }}><span>活跃职位</span><strong>{positionFacets.totals.active}</strong></button>
                {POSITION_STATUSES.map((status) => <button className={positionStatus === status && positionArchive === "active" ? "active" : ""} type="button" key={status} onClick={() => { setPositionStatus(status); setPositionArchive("active"); }}><span>{POSITION_STATUS_LABELS[status]}</span><strong>{positionFacets.status_counts[status] ?? 0}</strong></button>)}
                <button className={positionArchive === "archived" ? "active" : ""} type="button" onClick={() => { setPositionArchive("archived"); setPositionStatus("all"); }}><span>已归档</span><strong>{positionFacets.totals.archived}</strong></button>
              </div>

              <div className="workspace-toolbar">
                <label className="workspace-search"><Search size={17} /><input value={positionSearch} onChange={(event) => setPositionSearch(event.target.value)} placeholder="搜索职位名称、部门或地点" />{positionSearch && <button type="button" onClick={() => setPositionSearch("")} aria-label="清除搜索" title="清除"><X size={15} /></button>}</label>
                <button className={`button filter-toggle ${positionFiltersOpen || positionFilterCount ? "is-active" : ""}`} type="button" onClick={() => setPositionFiltersOpen((current) => !current)}><Filter size={16} />筛选{positionFilterCount ? <span>{positionFilterCount}</span> : null}</button>
                <div className="toolbar-spacer" /><label className="compact-select"><span className="sr-only">职位排序</span><select value={positionSort} onChange={(event) => setPositionSort(event.target.value)}><option value="updated_desc">最近更新</option><option value="title_asc">职位名称</option><option value="candidates_desc">候选人数</option><option value="headcount_desc">计划人数</option></select></label>
              </div>
              <div className={`filter-panel position-filter-panel ${positionFiltersOpen ? "is-open" : ""}`}>
                <label><span>职位状态</span><select value={positionStatus} onChange={(event) => setPositionStatus(event.target.value as "all" | PositionStatus)}><option value="all">全部状态</option>{POSITION_STATUSES.map((status) => <option value={status} key={status}>{POSITION_STATUS_LABELS[status]}</option>)}</select></label>
                <label><span>部门</span><select value={positionDepartment} onChange={(event) => setPositionDepartment(event.target.value)}><option value="all">全部部门</option>{availableDepartments.map((value) => <option key={value}>{value}</option>)}</select></label>
                <label><span>负责人</span><select value={positionOwner} onChange={(event) => setPositionOwner(event.target.value)}><option value="all">全部负责人</option>{availablePositionOwners.map((value) => <option key={value}>{value}</option>)}</select></label>
                <label><span>工作地点</span><select value={positionLocation} onChange={(event) => setPositionLocation(event.target.value)}><option value="all">全部地点</option>{availableLocations.map((value) => <option key={value}>{value}</option>)}</select></label>
                <label><span>归档状态</span><select value={positionArchive} onChange={(event) => setPositionArchive(event.target.value as ArchiveFilter)}><option value="active">未归档</option><option value="archived">已归档</option><option value="all">全部职位</option></select></label>
              </div>
              {(positionSearch || positionFilterCount > 0) && <div className="active-filter-bar"><span>{positionPagination.total} 个结果</span><button type="button" onClick={clearPositionFilters}>清除全部筛选<X size={13} /></button></div>}

              {selectedPositionIds.size > 0 && <div className="bulk-action-bar position-delete-bulk-bar"><span><Check size={16} />已选择 {selectedPositionIds.size} 个{selectedPositionKind === "archived" ? "已归档" : "活动"}职位{selectedPositionIds.size > 100 ? "，单批上限为 100" : ""}</span><div><button className="button secondary-button" type="button" onClick={() => setSelectedPositionIds(new Set())}>取消选择</button>{selectedPositionKind === "archived" ? <button className="button danger-button" type="button" disabled={selectedPositionIds.size > 100} onClick={requestBulkPermanentDeletePositions}><Trash2 size={16} />批量永久删除</button> : <button className="button danger-quiet-button" type="button" disabled={selectedPositionIds.size > 100} onClick={requestBulkArchivePositions}><Archive size={16} />批量归档</button>}</div></div>}
              {positionListError && <div className="workspace-error" role="alert"><span>{positionListError}</span><button className="button secondary-button" type="button" onClick={() => setRefreshVersion((value) => value + 1)}>重新加载</button></div>}
              <PositionTable positions={visiblePositions} loading={positionListLoading} busyPositionId={busyPositionId} selectedIds={selectedPositionIds} selectionKind={selectedPositionKind} onToggle={togglePositionSelection} onToggleAll={toggleAllPositionSelection} onOpen={openPosition} onEdit={(position) => openPositionForm("edit", position)} onArchive={requestArchivePosition} onRestore={(position) => void restorePosition(position)} onDelete={requestPermanentDeletePosition} />
              <Pagination pagination={positionPagination} pageSize={positionPageSize} entityLabel="个职位" loading={positionListLoading} onPageChange={setPositionPage} onPageSizeChange={setPositionPageSize} />
            </section>
          )}

          {page === "position-detail" && positionDetail && (
            <PositionDetailPage
              position={positionDetail}
              candidates={positionCandidates}
              loading={positionDetailLoading}
              busy={busyPositionId === positionDetail?.id}
              busyCandidateId={busyLinkedCandidateId}
              pagination={positionCandidatePagination}
              pageSize={positionCandidatePageSize}
              onBack={() => navigate("positions")}
              onEdit={(position) => openPositionForm("edit", position)}
              onArchive={requestArchivePosition}
              onRestore={(position) => void restorePosition(position)}
              onDelete={requestPermanentDeletePosition}
              onAddExisting={() => setCandidatePickerOpen(true)}
              onCreateCandidate={(position) => createCandidate(position.id)}
              onOpenCandidate={openCandidate}
              onUnlinkCandidate={(position, candidate) => void unlinkFromActivePosition(position, candidate)}
              onBulkUnlink={(position, ids) => void bulkUnlinkFromActivePosition(position, ids)}
              onExport={(position) => exportCandidates("xlsx", position.id)}
              onPageChange={setPositionCandidatePage}
              onPageSizeChange={(pageSize) => { setPositionCandidatePageSize(pageSize); setPositionCandidatePage(1); }}
            />
          )}
          {page === "position-detail" && !positionDetail && (
            positionDetailError ? (
              <div className="workspace-error position-detail-error" role="alert"><span>{positionDetailError}</span><div><button className="button secondary-button" type="button" onClick={() => navigate("positions")}>返回职位列表</button>{activePositionId && <button className="button primary-button" type="button" onClick={() => void loadPositionDetail(activePositionId)}>重新加载</button>}</div></div>
            ) : (
              <div className="position-detail-loading" aria-busy="true"><div className="page-title-skeleton skeleton-block" /><div className="overview-panel skeleton-block" /></div>
            )
          )}
        </main>
      </div>

      <CandidateDrawer mode={drawerMode} candidate={currentCandidate} notes={candidateDetail?.notes ?? []} activities={candidateDetail?.activities ?? []} positions={activePositionOptions} talentPools={talentPools.filter((pool) => !pool.archived_at)} busy={candidateBusy} positionBusy={candidateBusy} sensitiveBusy={sensitiveBusy} sensitiveLoaded={sensitiveLoaded} onRevealSensitive={() => void revealCandidateSensitive()} onClose={() => { if (!candidateBusy) { setDrawerMode(null); setCreateForPositionId(null); setSensitiveLoaded(false); } }} onEdit={() => currentCandidate && editCandidate(currentCandidate)} onSave={(draft) => void saveCandidate(draft)} onArchive={() => currentCandidate && void archiveCandidate(currentCandidate)} onRestore={() => currentCandidate && void restoreCandidate(currentCandidate)} onDelete={() => currentCandidate && requestPermanentDelete(currentCandidate)} onAddNote={(content) => void addNote(content)} onLinkPosition={(positionId) => void linkCandidateToPosition(positionId)} onUnlinkPosition={(positionId) => void unlinkCandidateFromPosition(positionId)} onOpenPosition={openPosition} onLinkTalentPool={(poolId) => void linkCandidateToTalentPool(poolId)} onUnlinkTalentPool={(poolId) => void unlinkCandidateFromTalentPool(poolId)} onCandidateUpdated={() => currentCandidate && void loadCandidateDetail(currentCandidate.id, sensitiveLoaded)} />
      <PositionFormDrawer mode={positionFormMode} position={editingPosition} ownerOptions={Array.from(new Set([...availableCandidateOwners, ...availablePositionOwners]))} busy={positionFormBusy} submitError={positionFormError} onClose={() => !positionFormBusy && setPositionFormMode(null)} onSubmit={(draft) => void savePosition(draft)} />
      <CandidatePickerDialog open={candidatePickerOpen} excludePositionId={activePositionId ?? undefined} busy={candidatePickerBusy} onClose={() => !candidatePickerBusy && setCandidatePickerOpen(false)} onConfirm={(ids) => void addCandidatesToActivePosition(ids)} />
      {linkTargetCandidateIds.length > 0 && (
        <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !linkDialogBusy && setLinkTargetCandidateIds([])}>
          <div className="modal compact-modal" role="dialog" aria-modal="true" aria-label="关联职位">
            <header className="modal-header"><div><p className="drawer-kicker">批量整理</p><h2>关联招聘职位</h2></div><button className="icon-button" type="button" onClick={() => setLinkTargetCandidateIds([])} disabled={linkDialogBusy} aria-label="关闭" title="关闭"><X size={19} /></button></header>
            <div className="modal-body link-position-body"><span className="modal-icon"><BriefcaseBusiness size={22} /></span><p>将 {linkTargetCandidateIds.length} 位候选人关联到：</p><label className="field"><span>选择职位</span><select value={linkTargetPositionId} onChange={(event) => setLinkTargetPositionId(event.target.value)}><option value="">请选择职位</option>{activePositionOptions.filter((position) => position.status !== "closed").map((position) => <option value={position.id} key={position.id}>{position.title} · {POSITION_STATUS_LABELS[position.status]}</option>)}</select></label></div>
            <footer className="modal-footer"><button className="button secondary-button" type="button" onClick={() => setLinkTargetCandidateIds([])} disabled={linkDialogBusy}>取消</button><button className="button primary-button" type="button" onClick={() => void confirmBulkLink()} disabled={!linkTargetPositionId || linkDialogBusy}>{linkDialogBusy ? "正在关联..." : "确认关联"}</button></footer>
          </div>
        </div>
      )}
      {importOpen && <ImportWizard onClose={() => setImportOpen(false)} onImported={(result: ImportResult) => { navigate("candidates"); void loadWorkspace(false); notify(`导入完成：${result.imported} 条成功`); }} />}
      <AssistantDrawer open={assistantOpen} configured={agentConfigured} candidates={candidates} positions={positions} talentPools={talentPools} onClose={() => setAssistantOpen(false)} onOpenCandidateId={(candidateId) => void openCandidateById(candidateId)} onCandidatesUpdated={() => void loadWorkspace(false)} />
      {confirmAction && <ConfirmDialog action={confirmAction} busy={confirmBusy} onCancel={() => !confirmBusy && setConfirmAction(null)} onConfirm={async () => { setConfirmBusy(true); try { await confirmAction.run(); setConfirmAction(null); } catch (error) { notify(errorMessage(error, "操作失败")); } finally { setConfirmBusy(false); } }} />}
      {permanentDeleteRequest && <PermanentDeleteDialog entity={permanentDeleteRequest.entity} requestedCount={permanentDeleteRequest.ids.length} preview={permanentDeleteRequest.preview} loading={permanentDeleteRequest.loading} committing={permanentDeleteRequest.committing} error={permanentDeleteRequest.error} onCancel={() => !permanentDeleteRequest.loading && !permanentDeleteRequest.committing && setPermanentDeleteRequest(null)} onRetry={() => void requestPermanentDeletePreview(permanentDeleteRequest.entity, permanentDeleteRequest.ids)} onConfirm={() => void commitPermanentDelete()} />}
      {toast && <div className={`toast${toast.tone === "warning" ? " is-warning" : ""}`} role="status"><Check size={16} /><span>{toast.message}</span>{toast.action && <button type="button" onClick={() => { const action = toast.action; setToast(null); if (action) Promise.resolve(action()).catch((error) => notify(errorMessage(error, "撤销操作失败"), { tone: "warning" })); }}><Undo2 size={14} />{toast.actionLabel}</button>}</div>}
      {sidebarOpen && <button className="mobile-scrim" type="button" onClick={() => setSidebarOpen(false)} aria-label="关闭导航" />}
    </div>
  );
}

function ExportMenu({ count, onExport }: { count: number; onExport: (format: "xlsx" | "csv") => void }) {
  return (
    <div className="export-menu" role="menu">
      <button type="button" role="menuitem" onClick={() => onExport("xlsx")}><FileSpreadsheet size={17} /><span><strong>Excel 工作簿</strong><small>{count} 条当前结果</small></span></button>
      <button type="button" role="menuitem" onClick={() => onExport("csv")}><FileDown size={17} /><span><strong>CSV 文件</strong><small>UTF-8 编码</small></span></button>
    </div>
  );
}

function ActiveCandidateFilters(props: {
  search: string;
  source: string;
  owner: string;
  tag: string;
  positionId: string;
  poolId: string;
  education: string;
  school: string;
  gender: string;
  jobStatus: string;
  archive: ArchiveFilter;
  positions: Position[];
  talentPools: TalentPool[];
  onClearSearch: () => void;
  onClearSource: () => void;
  onClearOwner: () => void;
  onClearTag: () => void;
  onClearPosition: () => void;
  onClearPool: () => void;
  onClearEducation: () => void;
  onClearSchool: () => void;
  onClearGender: () => void;
  onClearJobStatus: () => void;
  onClearArchive: () => void;
  onClearAll: () => void;
}) {
  const chips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (props.search) chips.push({ key: "search", label: `搜索：${props.search}`, clear: props.onClearSearch });
  if (props.positionId !== "all") chips.push({ key: "position", label: props.positionId === "unassigned" ? "职位：未分配" : `职位：${props.positions.find((item) => item.id === props.positionId)?.title ?? "未知"}`, clear: props.onClearPosition });
  if (props.poolId !== "all") chips.push({ key: "pool", label: props.poolId === "unassigned" ? "人才库：未分组" : `人才库：${props.talentPools.find((item) => item.id === props.poolId)?.name ?? "未知"}`, clear: props.onClearPool });
  if (props.education !== "all") chips.push({ key: "education", label: `学历：${props.education}`, clear: props.onClearEducation });
  if (props.school !== "all") chips.push({ key: "school", label: `学校：${props.school}`, clear: props.onClearSchool });
  if (props.gender !== "all") chips.push({ key: "gender", label: `性别：${props.gender}`, clear: props.onClearGender });
  if (props.jobStatus !== "all") chips.push({ key: "job-status", label: `求职状态：${props.jobStatus}`, clear: props.onClearJobStatus });
  if (props.source !== "all") chips.push({ key: "source", label: `来源：${props.source}`, clear: props.onClearSource });
  if (props.owner !== "all") chips.push({ key: "owner", label: `负责人：${props.owner}`, clear: props.onClearOwner });
  if (props.tag !== "all") chips.push({ key: "tag", label: `标签：${props.tag}`, clear: props.onClearTag });
  if (props.archive !== "active") chips.push({ key: "archive", label: props.archive === "archived" ? "仅已归档" : "含已归档", clear: props.onClearArchive });
  if (!chips.length) return null;
  return <div className="active-filter-bar"><div className="filter-chips">{chips.map((chip) => <button type="button" key={chip.key} onClick={chip.clear}>{chip.label}<X size={13} /></button>)}</div><button className="clear-all-filters" type="button" onClick={props.onClearAll}>清除全部</button></div>;
}

function Pagination({
  pagination,
  pageSize,
  entityLabel,
  loading,
  onPageChange,
  onPageSizeChange,
}: {
  pagination: PaginationState;
  pageSize: PageSize;
  entityLabel: string;
  loading?: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: PageSize) => void;
}) {
  const page = pagination.total ? pagination.page : 1;
  const pageCount = Math.max(1, pagination.total_pages);
  const hasNext = pagination.has_next ?? page < pageCount;
  return (
    <div className="pagination">
      <div className="pagination-summary">
        <span>共 {pagination.total} {entityLabel}</span>
        <label>每页
          <select value={pageSize} disabled={loading} onChange={(event) => onPageSizeChange(Number(event.target.value) as PageSize)}>
            {PAGE_SIZES.map((size) => <option value={size} key={size}>{size}</option>)}
          </select>
        </label>
      </div>
      <div>
        <button className="icon-button" type="button" disabled={loading || pagination.total === 0 || page <= 1} onClick={() => onPageChange(page - 1)} aria-label="上一页" title="上一页"><ChevronLeft size={17} /></button>
        <strong>{pagination.total ? `${page} / ${pageCount}` : "0 / 0"}</strong>
        <button className="icon-button" type="button" disabled={loading || pagination.total === 0 || !hasNext} onClick={() => onPageChange(page + 1)} aria-label="下一页" title="下一页"><ChevronRight size={17} /></button>
      </div>
    </div>
  );
}

function CandidateListSkeleton() {
  return <div className="list-skeleton" aria-label="正在加载候选人" aria-busy="true">{[0, 1, 2, 3, 4, 5].map((item) => <div className="skeleton-row" key={item}><span className="skeleton-avatar skeleton-block" /><span className="skeleton-line skeleton-block" /><span className="skeleton-line short skeleton-block" /></div>)}</div>;
}

function ConfirmDialog({ action, busy, onCancel, onConfirm }: { action: ConfirmAction; busy: boolean; onCancel: () => void; onConfirm: () => Promise<void> }) {
  return <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}><div className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-label={action.title}><header className="modal-header"><div><p className="drawer-kicker">操作确认</p><h2>{action.title}</h2></div><button className="icon-button" type="button" onClick={onCancel} disabled={busy} aria-label="关闭" title="关闭"><X size={19} /></button></header><div className="modal-body confirm-body"><span className={`confirm-icon ${action.tone === "danger" ? "danger" : ""}`}><Archive size={22} /></span><p>{action.message}</p></div><footer className="modal-footer"><button className="button secondary-button" type="button" onClick={onCancel} disabled={busy}>取消</button><button className={`button ${action.tone === "danger" ? "danger-button" : "primary-button"}`} type="button" onClick={() => void onConfirm()} disabled={busy}>{busy ? "正在处理..." : action.confirmLabel}</button></footer></div></div>;
}

export default App;
