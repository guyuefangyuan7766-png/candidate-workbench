import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Bot,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  Download,
  Filter,
  FolderKanban,
  LayoutDashboard,
  List,
  Loader2,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
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
  authStatus,
  getAgentStatus,
  getAuthSession,
  getDashboard,
  logout as logoutRequest,
  onUnauthorized,
  positionApi,
  talentPoolApi,
  ApiError,
  type CandidateDetail,
  type PermanentDeletePreview,
} from "./api";
import type { AuthUser } from "./auth";
import { LoginPage } from "./components/LoginPage";
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
import { CandidateDrawer, type DetailTab, type DrawerMode } from "./components/CandidateDrawer";
import { CandidatePickerDialog } from "./components/CandidatePickerDialog";
import { hasRecoverableImportTask, ImportWizard } from "./components/ImportWizard";
import { Overview } from "./components/Overview";
import { PositionDetailPage } from "./components/PositionDetailPage";
import { PositionFormDrawer, type PositionFormMode } from "./components/PositionFormDrawer";
import { PositionsView } from "./views/PositionsView";
import { PermanentDeleteDialog, type PermanentDeleteEntity } from "./components/PermanentDeleteDialog";
import { TalentPoolPage } from "./components/TalentPoolPage";
import { AppShell } from "./views/AppShell";
import { CandidatesView, type CandidateListView } from "./views/CandidatesView";

type Page = "dashboard" | "candidates" | "talent-pools" | "positions" | "position-detail";
type ToolPage = "assistant" | "resume-search" | "attachment-parser";
type AssistantPanel = "main" | "history";

/* 第十二轮：导航表面（主页面 / 工具页 / 导入页）是互斥的单一状态。
   URL 与表面一一对应，禁止再用并列布尔量表达「哪个表面打开」。 */
type Surface =
  | { kind: "page" }
  | { kind: "tool"; tool: ToolPage }
  | { kind: "import" };

function toolPath(tool: ToolPage) {
  return tool === "assistant" ? "/assistant" : tool === "resume-search" ? "/resume-search" : "/attachment-parser";
}
type CandidateView = "list" | "grouped";
type ArchiveFilter = "active" | "archived" | "all";
type AuthState =
  | { status: "checking"; user: null }
  | { status: "anonymous"; user: null }
  | { status: "authenticated"; user: AuthUser | null };

const SIDEBAR_COLLAPSED_STORAGE_KEY = "candidate-workbench.sidebar-collapsed";
type PageSize = 20 | 50 | 100;
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

function initialRoute(): { page: Page; positionId: string | null; surface: Surface } {
  const positionMatch = window.location.pathname.match(/^\/positions\/([^/]+)$/);
  if (positionMatch) return { page: "position-detail", positionId: decodeURIComponent(positionMatch[1]), surface: { kind: "page" } };
  if (window.location.pathname === "/candidates") return { page: "candidates", positionId: null, surface: { kind: "page" } };
  if (window.location.pathname === "/talent-pools") return { page: "talent-pools", positionId: null, surface: { kind: "page" } };
  if (window.location.pathname === "/positions") return { page: "positions", positionId: null, surface: { kind: "page" } };
  if (window.location.pathname === "/assistant") return { page: "dashboard", positionId: null, surface: { kind: "tool", tool: "assistant" } };
  if (window.location.pathname === "/resume-search") return { page: "dashboard", positionId: null, surface: { kind: "tool", tool: "resume-search" } };
  if (window.location.pathname === "/attachment-parser") return { page: "dashboard", positionId: null, surface: { kind: "tool", tool: "attachment-parser" } };
  if (window.location.pathname === "/import") return { page: "dashboard", positionId: null, surface: { kind: "import" } };
  return { page: "dashboard", positionId: null, surface: { kind: "page" } };
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? `${fallback}：${error.message}` : fallback;
}

function App() {
  const initial = useMemo(initialRoute, []);
  const [authState, setAuthState] = useState<AuthState>({ status: "checking", user: null });
  const [loginNotice, setLoginNotice] = useState("");
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
  const [drawerInitialTab, setDrawerInitialTab] = useState<DetailTab>("attachment");
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [candidateDetail, setCandidateDetail] = useState<CandidateDetail | null>(null);
  const [sensitiveLoaded, setSensitiveLoaded] = useState(false);
  const [sensitiveBusy, setSensitiveBusy] = useState(false);
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [createForPositionId, setCreateForPositionId] = useState<string | null>(null);
  const [pendingCreatedCandidateId, setPendingCreatedCandidateId] = useState<string | null>(null);
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

  const [surface, setSurface] = useState<Surface>(() => {
    if (initial.surface.kind !== "page") return initial.surface;
    if (hasRecoverableImportTask()) {
      window.history.replaceState({}, "", "/import");
      return { kind: "import" };
    }
    return initial.surface;
  });
  const importOpen = surface.kind === "import";
  const toolOpen = surface.kind === "tool";
  const toolPage = surface.kind === "tool" ? surface.tool : null;
  const [assistantPanel, setAssistantPanel] = useState<AssistantPanel>("main");
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
    // The workspace loader also runs from buttons and post-mutation refreshes,
    // so it has to gate on the same rule as the boot effect: never call the
    // business API while the session is unknown or absent.
    if (authState.status !== "authenticated") return;
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
  }, [authState.status]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const requiresAuth = await authStatus().then((status) => status.enabled).catch(() => false);
      if (cancelled) return;
      if (!requiresAuth) {
        setAuthState({ status: "authenticated", user: null });
        return;
      }
      const session = await getAuthSession().catch(() => null);
      if (cancelled) return;
      setAuthState(session ? { status: "authenticated", user: session.user } : { status: "anonymous", user: null });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return onUnauthorized(() => {
      setLoginNotice("登录状态已过期，请重新登录。");
      setAuthState((current) => (current.status === "anonymous" ? current : { status: "anonymous", user: null }));
    });
  }, []);

  useEffect(() => {
    if (authState.status !== "authenticated") return;
    void loadWorkspace();
    getAgentStatus().then((status) => setAgentConfigured(status.configured)).catch(() => setAgentConfigured(false));
  }, [authState.status, loadWorkspace]);

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
    const overlayOpen = Boolean(
      drawerMode
      || positionFormMode
      || candidatePickerOpen
      || linkTargetCandidateIds.length
      || importOpen
      || confirmAction
      || permanentDeleteRequest,
    );
    document.body.classList.toggle("has-overlay", overlayOpen);
    return () => document.body.classList.remove("has-overlay");
  }, [toolOpen, candidatePickerOpen, confirmAction, drawerMode, importOpen, linkTargetCandidateIds.length, permanentDeleteRequest, positionFormMode]);

  useEffect(() => {
    const closeTopLayer = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (permanentDeleteRequest && !permanentDeleteRequest.loading && !permanentDeleteRequest.committing) return setPermanentDeleteRequest(null);
      if (confirmAction && !confirmBusy) return setConfirmAction(null);
      if (linkTargetCandidateIds.length && !linkDialogBusy) return setLinkTargetCandidateIds([]);
      if (candidatePickerOpen && !candidatePickerBusy) return setCandidatePickerOpen(false);
      if (positionFormMode && !positionFormBusy) return setPositionFormMode(null);
      if (drawerMode && !candidateBusy) return setDrawerMode(null);
      if (toolOpen) return closeToolPage();
      if (importOpen) return closeImport();
      if (candidateFiltersOpen) return setCandidateFiltersOpen(false);
      if (positionFiltersOpen) setPositionFiltersOpen(false);
    };
    window.addEventListener("keydown", closeTopLayer);
    return () => window.removeEventListener("keydown", closeTopLayer);
  }, [toolOpen, importOpen, candidateBusy, candidateFiltersOpen, candidatePickerBusy, candidatePickerOpen, confirmAction, confirmBusy, drawerMode, linkDialogBusy, linkTargetCandidateIds.length, permanentDeleteRequest, positionFiltersOpen, positionFormBusy, positionFormMode, page, activePositionId]);

  useEffect(() => {
    const handlePopState = () => {
      const route = initialRoute();
      setPage(route.page);
      setActivePositionId(route.positionId);
      setSurface(route.surface);
      setAssistantPanel("main");
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

  function currentPagePath() {
    if (page === "position-detail" && activePositionId) return `/positions/${encodeURIComponent(activePositionId)}`;
    return page === "dashboard" ? "/" : `/${page}`;
  }

  /* 导航动作先落地新 surface，再清理抽屉/弹层，避免两个表面同时可见。 */
  function closeTransientLayers() {
    setDrawerMode(null);
    setPositionFormMode(null);
    setCandidatePickerOpen(false);
    setLinkTargetCandidateIds([]);
    setCandidateFiltersOpen(false);
    setPositionFiltersOpen(false);
  }

  function navigate(next: Exclude<Page, "position-detail">, replace = false) {
    const path = next === "dashboard" ? "/" : `/${next}`;
    setSurface({ kind: "page" });
    setAssistantPanel("main");
    closeTransientLayers();
    window.history[replace ? "replaceState" : "pushState"]({}, "", path);
    setPage(next);
    setActivePositionId(null);
    setSidebarOpen(false);
  }

  /* 点击已激活入口 = 关闭并回到进入前的页面；点击其他入口 = 切换，不叠加。 */
  function openTool(next: ToolPage) {
    if (surface.kind === "tool" && surface.tool === next) {
      closeToolPage();
      return;
    }
    if (next !== "assistant") setAssistantPanel("main");
    setSurface({ kind: "tool", tool: next });
    setSidebarOpen(false);
    const path = toolPath(next);
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
  }

  function closeToolPage() {
    const returnPath = currentPagePath();
    setAssistantPanel("main");
    setSurface({ kind: "page" });
    if (window.location.pathname !== returnPath) window.history.pushState({}, "", returnPath);
  }

  function openImport() {
    if (surface.kind === "import") {
      closeImport();
      return;
    }
    setSurface({ kind: "import" });
    setAssistantPanel("main");
    setSidebarOpen(false);
    if (window.location.pathname !== "/import") window.history.pushState({}, "", "/import");
  }

  function closeImport() {
    const returnPath = currentPagePath();
    setSurface({ kind: "page" });
    if (window.location.pathname !== returnPath) window.history.pushState({}, "", returnPath);
  }

  function openPosition(position: Position) {
    window.history.pushState({}, "", `/positions/${encodeURIComponent(position.id)}`);
    setPage("position-detail");
    setActivePositionId(position.id);
    setPositionDetail(position);
    setSidebarOpen(false);
    setDrawerMode(null);
  }

  // 默认落在「附件简历」页签（无简历附件的候选人由抽屉自动回落到「档案」）。
  function openCandidate(candidate: Candidate, tab: DetailTab = "attachment") {
    setDrawerInitialTab(tab);
    setSensitiveLoaded(false);
    setSelectedCandidateId(candidate.id);
    setCandidateDetail(candidate as CandidateDetail);
    setDrawerMode("detail");
    void loadCandidateDetail(candidate.id);
  }

  async function openCandidateById(candidateId: string, tab: DetailTab = "attachment") {
    const currentPageCandidate = candidates.find((candidate) => candidate.id === candidateId);
    if (currentPageCandidate) {
      openCandidate(currentPageCandidate, tab);
      return;
    }
    try {
      const detail = await candidateApi.get(candidateId);
      setDrawerInitialTab(tab);
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
    setPendingCreatedCandidateId(null);
    setDrawerMode("create");
  }

  async function saveCandidate(draft: CandidateDraft) {
    setCandidateBusy(true);
    try {
      const { preferences, profile_sections: draftProfileSections, stage: _legacyStage, expected_salary: _legacySalary, ...candidateFields } = draft;
      const profile_sections = draftProfileSections ?? [];
      if (drawerMode === "create") {
        let linkedToRequestedPosition = false;
        let created: Candidate;
        const retryCandidateId = pendingCreatedCandidateId;
        if (retryCandidateId) {
          await candidateApi.updatePreferences(retryCandidateId, preferences);
          await candidateApi.replaceProfileSections(retryCandidateId, profile_sections ?? []);
          created = await candidateApi.get(retryCandidateId, true);
        } else {
          created = await candidateApi.create({ ...candidateFields, source_system: "manual", source_record_id: crypto.randomUUID() });
          setPendingCreatedCandidateId(created.id);
          try {
            await candidateApi.updatePreferences(created.id, preferences);
            await candidateApi.replaceProfileSections(created.id, profile_sections);
          } catch (saveError) {
            notify(errorMessage(saveError, "候选人已创建，偏好或履历未完整保存；请再次提交以重试"), { tone: "warning" });
            return;
          }
        }
        if (createForPositionId) {
          try {
            await positionApi.linkCandidates(createForPositionId, [created.id]);
            linkedToRequestedPosition = true;
          } catch (linkError) {
            notify(errorMessage(linkError, "候选人已创建，但自动关联职位失败"));
          }
        }
        setSelectedCandidateId(created.id);
        setPendingCreatedCandidateId(null);
        setDrawerMode("detail");
        setCreateForPositionId(null);
        await Promise.all([loadCandidateDetail(created.id, true), loadWorkspace(false)]);
        if (activePositionId) await loadPositionDetail(activePositionId, false);
        if (!createForPositionId || linkedToRequestedPosition) {
          notify(linkedToRequestedPosition ? "候选人已创建并关联该招聘职位" : "候选人档案已创建");
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
        if (Array.isArray(profile_sections)) await candidateApi.replaceProfileSections(selectedCandidateId, profile_sections);
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
      title: `归档 ${candidateIds.length} 位候选人`,
      message: "归档后将从在库列表隐藏，候选人资料和全部关系都会保留，可在已归档中逐一恢复。",
      confirmLabel: "确认归档",
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
      notify("已从该招聘职位解除关联");
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
      notify("该招聘职位候选人导出文件正在生成");
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
  const candidateAdvancedFilterCount = [candidateOwner, candidateTag, candidateSchool, candidateGender, candidateJobStatus]
    .filter((value) => value !== "all").length;
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

  async function handleLogout() {
    try {
      await logoutRequest();
    } catch {
      // Even if the server call fails, the local session must not linger in
      // the UI: the next protected request would only bounce back to login.
    }
    setLoginNotice("");
    setAuthState({ status: "anonymous", user: null });
  }

  if (authState.status === "checking") {
    return (
      <div className="tw-login">
        <div className="tw-login-card tw-login-wait" role="status" aria-live="polite">
          <span className="tw-login-mark">
            <strong>拾才</strong>
            <small>让优秀的人更容易被看见</small>
          </span>
          <p><Loader2 className="tw-login-spin" size={16} aria-hidden="true" />正在校验登录状态…</p>
        </div>
      </div>
    );
  }

  if (authState.status === "anonymous") {
    return (
      <LoginPage
        notice={loginNotice}
        onSuccess={(user) => {
          setLoginNotice("");
          setAuthState({ status: "authenticated", user });
        }}
      />
    );
  }

  return (


    <>
      <AppShell
        page={page}
        toolPage={toolPage}
        toolOpen={toolOpen}
        importOpen={importOpen}
        collapsed={sidebarCollapsed}
        mobileOpen={sidebarOpen}
        assistantHistoryOpen={assistantPanel === "history"}
        agentConfigured={agentConfigured}
        user={authState.user}
        onLogout={() => void handleLogout()}
        title={title}
        onNavigate={navigate}
        onOpenTool={openTool}
        onOpenImport={openImport}
        onToggleCollapse={toggleDesktopSidebar}
        onToggleMobile={() => setSidebarOpen((current) => !current)}
      >
        <div className="tw-content-stack" hidden={surface.kind !== "page"}>
          {workspaceError && (
            <div className="tw-alert" role="alert"><span>{workspaceError}</span><button className="tw-btn tw-btn-sm" type="button" onClick={() => void loadWorkspace()}>重新加载</button></div>
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
              onImport={openImport}
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
            <CandidatesView
              candidates={filteredCandidates}
              loading={candidateListLoading}
              error={candidateListError}
              scope={candidateArchive}
              scopeCounts={{ active: activeCandidateTotal, archived: archivedCandidateTotal, total: candidateFacets.totals.total }}
              search={candidateSearch}
              filters={{
                source: candidateSource,
                owner: candidateOwner,
                tag: candidateTag,
                position: candidatePosition,
                pool: candidatePool,
                education: candidateEducation,
                school: candidateSchool,
                gender: candidateGender,
                jobStatus: candidateJobStatus,
              }}
              facets={candidateFacets}
              positions={positionLookup}
              talentPools={talentPools}
              sort={candidateSort}
              view={candidateView}
              pageSize={candidatePageSize}
              pagination={candidatePagination}
              selection={selectedCandidateIds}
              selectionKind={selectedCandidateKind}
              onScopeChange={(next) => { setCandidateArchive(next); if (next === "archived") setCandidateView("list"); }}
              onSearchChange={setCandidateSearch}
              onFilterChange={(key, value) => {
                if (key === "source") setCandidateSource(value);
                else if (key === "owner") setCandidateOwner(value);
                else if (key === "tag") setCandidateTag(value);
                else if (key === "position") setCandidatePosition(value);
                else if (key === "pool") setCandidatePool(value);
                else if (key === "education") setCandidateEducation(value);
                else if (key === "school") setCandidateSchool(value);
                else if (key === "gender") setCandidateGender(value);
                else if (key === "jobStatus") setCandidateJobStatus(value);
              }}
              onClearFilters={clearCandidateFilters}
              onSortChange={setCandidateSort}
              onViewChange={setCandidateView}
              onPageChange={setCandidatePage}
              onPageSizeChange={setCandidatePageSize}
              onReload={() => setRefreshVersion((value) => value + 1)}
              onToggleSelection={toggleCandidateSelection}
              onToggleAllSelection={toggleAllCandidateSelection}
              onOpenCandidate={openCandidate}
              onEditCandidate={editCandidate}
              onArchiveCandidate={(candidate) => void archiveCandidate(candidate)}
              onRestoreCandidate={(candidate) => void restoreCandidate(candidate)}
              onDeleteCandidate={requestPermanentDelete}
              onLinkPositions={openBulkLink}
              onOpenPosition={openPosition}
              onClearSelection={() => setSelectedCandidateIds(new Set())}
              onBulkArchive={requestBulkArchive}
              onBulkDelete={requestBulkPermanentDeleteCandidates}
              onBulkLink={() => openBulkLink([...selectedCandidateIds])}
              onImport={openImport}
              onExport={exportCandidates}
              onCreate={() => createCandidate()}
            />
          )}

          {page === "positions" && (
            <PositionsView
              positions={visiblePositions}
              loading={positionListLoading}
              error={positionListError}
              facets={positionFacets}
              search={positionSearch}
              filters={{ status: positionStatus, archive: positionArchive, department: positionDepartment, owner: positionOwner, location: positionLocation }}
              sort={positionSort}
              pageSize={positionPageSize}
              pagination={positionPagination}
              selection={selectedPositionIds}
              selectionKind={selectedPositionKind}
              busyPositionId={busyPositionId}
              departments={availableDepartments}
              owners={availablePositionOwners}
              locations={availableLocations}
              onSearchChange={setPositionSearch}
              onFilterChange={(key, value) => {
                if (key === "status") setPositionStatus(value as "all" | PositionStatus);
                else if (key === "archive") setPositionArchive(value as ArchiveFilter);
                else if (key === "department") setPositionDepartment(value);
                else if (key === "owner") setPositionOwner(value);
                else if (key === "location") setPositionLocation(value);
              }}
              onSortChange={setPositionSort}
              onPageChange={setPositionPage}
              onPageSizeChange={setPositionPageSize}
              onReload={() => setRefreshVersion((value) => value + 1)}
              onClearFilters={clearPositionFilters}
              onToggleSelection={togglePositionSelection}
              onToggleAllSelection={toggleAllPositionSelection}
              onClearSelection={() => setSelectedPositionIds(new Set())}
              onBulkArchive={requestBulkArchivePositions}
              onBulkDelete={requestBulkPermanentDeletePositions}
              onOpen={openPosition}
              onEdit={(position) => openPositionForm("edit", position)}
              onArchive={requestArchivePosition}
              onRestore={(position) => void restorePosition(position)}
              onDelete={requestPermanentDeletePosition}
              onCreate={() => openPositionForm("create")}
            />
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
              <div className="tw-alert tw-alert-inline is-danger" role="alert"><span>{positionDetailError}</span><div><button className="tw-btn" type="button" onClick={() => navigate("positions")}>返回职位列表</button>{activePositionId && <button className="tw-btn tw-btn-primary" type="button" onClick={() => void loadPositionDetail(activePositionId)}>重新加载</button>}</div></div>
            ) : (
              <div className="position-detail-loading" aria-busy="true"><div className="page-title-skeleton skeleton-block" /><div className="overview-panel skeleton-block" /></div>
            )
          )}
        </div>
        {importOpen && <ImportWizard presentation="page" onClose={closeImport} onImported={(result: ImportResult) => { setPage("candidates"); setActivePositionId(null); void loadWorkspace(false); notify(`导入完成：${result.imported} 条成功`); }} />}
        {toolOpen && toolPage && <AssistantDrawer
            open
            configured={agentConfigured}
            historyOpen={assistantPanel === "history"}
            candidates={candidates}
            positions={positions}
            talentPools={talentPools}
            initialTab={toolPage === "resume-search" ? "resume-search" : toolPage === "attachment-parser" ? "attachment" : "chat"}
          onOpenCandidateId={(candidateId, tab) => void openCandidateById(candidateId, tab ?? "attachment")}
            onCandidatesUpdated={() => void loadWorkspace(false)}
            onClose={closeToolPage}
            onHistoryOpenChange={(open) => setAssistantPanel(open ? "history" : "main")}
            onToolChange={openTool}
          />}
      </AppShell>

      <CandidateDrawer mode={drawerMode} initialTab={drawerInitialTab} candidate={currentCandidate} notes={candidateDetail?.notes ?? []} activities={candidateDetail?.activities ?? []} positions={activePositionOptions} talentPools={talentPools.filter((pool) => !pool.archived_at)} busy={candidateBusy} pendingProfileSave={Boolean(pendingCreatedCandidateId)} positionBusy={candidateBusy} sensitiveBusy={sensitiveBusy} sensitiveLoaded={sensitiveLoaded} onRevealSensitive={() => void revealCandidateSensitive()} onClose={() => { if (!candidateBusy) { setDrawerMode(null); setCreateForPositionId(null); setPendingCreatedCandidateId(null); setSensitiveLoaded(false); } }} onEdit={() => currentCandidate && editCandidate(currentCandidate)} onSave={(draft) => void saveCandidate(draft)} onArchive={() => currentCandidate && void archiveCandidate(currentCandidate)} onRestore={() => currentCandidate && void restoreCandidate(currentCandidate)} onDelete={() => currentCandidate && requestPermanentDelete(currentCandidate)} onAddNote={(content) => void addNote(content)} onLinkPosition={(positionId) => void linkCandidateToPosition(positionId)} onUnlinkPosition={(positionId) => void unlinkCandidateFromPosition(positionId)} onOpenPosition={openPosition} onLinkTalentPool={(poolId) => void linkCandidateToTalentPool(poolId)} onUnlinkTalentPool={(poolId) => void unlinkCandidateFromTalentPool(poolId)} onCandidateUpdated={() => currentCandidate && void loadCandidateDetail(currentCandidate.id, sensitiveLoaded)} onCandidateCreated={() => void loadWorkspace(false)} />
      <PositionFormDrawer mode={positionFormMode} position={editingPosition} ownerOptions={Array.from(new Set([...availableCandidateOwners, ...availablePositionOwners]))} busy={positionFormBusy} submitError={positionFormError} onClose={() => !positionFormBusy && setPositionFormMode(null)} onSubmit={(draft) => void savePosition(draft)} />
      <CandidatePickerDialog open={candidatePickerOpen} excludePositionId={activePositionId ?? undefined} busy={candidatePickerBusy} onClose={() => !candidatePickerBusy && setCandidatePickerOpen(false)} onConfirm={(ids) => void addCandidatesToActivePosition(ids)} />
      {linkTargetCandidateIds.length > 0 && (
        <div className="tw-modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !linkDialogBusy && setLinkTargetCandidateIds([])}>
          <section className="tw-modal tw-modal-md" role="dialog" aria-modal="true" aria-label="关联职位">
            <header className="tw-modal-head"><div><p className="tw-modal-kicker">批量整理</p><h2>关联招聘职位</h2></div><button className="tw-icon-plain" type="button" onClick={() => setLinkTargetCandidateIds([])} disabled={linkDialogBusy} aria-label="关闭" title="关闭"><X size={19} /></button></header>
            <div className="tw-modal-body tw-link-body"><span className="tw-object-icon"><BriefcaseBusiness size={22} /></span><p>将 {linkTargetCandidateIds.length} 位候选人关联到：</p><label className="tw-field"><span className="tw-field-label">选择职位</span><select value={linkTargetPositionId} onChange={(event) => setLinkTargetPositionId(event.target.value)}><option value="">请选择职位</option>{activePositionOptions.filter((position) => position.status !== "closed").map((position) => <option value={position.id} key={position.id}>{position.title} · {POSITION_STATUS_LABELS[position.status]}</option>)}</select></label></div>
            <footer className="tw-modal-foot"><button className="tw-btn" type="button" onClick={() => setLinkTargetCandidateIds([])} disabled={linkDialogBusy}>取消</button><button className="tw-btn tw-btn-primary" type="button" onClick={() => void confirmBulkLink()} disabled={!linkTargetPositionId || linkDialogBusy}>{linkDialogBusy ? "正在关联..." : "确认关联"}</button></footer>
          </section>
        </div>
      )}
      {confirmAction && <ConfirmDialog action={confirmAction} busy={confirmBusy} onCancel={() => !confirmBusy && setConfirmAction(null)} onConfirm={async () => { setConfirmBusy(true); try { await confirmAction.run(); setConfirmAction(null); } catch (error) { notify(errorMessage(error, "操作失败")); } finally { setConfirmBusy(false); } }} />}
      {permanentDeleteRequest && <PermanentDeleteDialog entity={permanentDeleteRequest.entity} requestedCount={permanentDeleteRequest.ids.length} preview={permanentDeleteRequest.preview} loading={permanentDeleteRequest.loading} committing={permanentDeleteRequest.committing} error={permanentDeleteRequest.error} onCancel={() => !permanentDeleteRequest.loading && !permanentDeleteRequest.committing && setPermanentDeleteRequest(null)} onRetry={() => void requestPermanentDeletePreview(permanentDeleteRequest.entity, permanentDeleteRequest.ids)} onConfirm={() => void commitPermanentDelete()} />}
      {toast && <div className={`tw-toast${toast.tone === "warning" ? " is-warning" : ""}`} role="status"><Check size={16} /><span>{toast.message}</span>{toast.action && <button type="button" onClick={() => { const action = toast.action; setToast(null); if (action) Promise.resolve(action()).catch((error) => notify(errorMessage(error, "撤销操作失败"), { tone: "warning" })); }}><Undo2 size={14} />{toast.actionLabel}</button>}</div>}
    </>
  );
}

function ConfirmDialog({ action, busy, onCancel, onConfirm }: { action: ConfirmAction; busy: boolean; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const danger = action.tone === "danger";
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return (
    <div className="tw-modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div className="tw-modal tw-confirm" role="alertdialog" aria-modal="true" aria-labelledby="tw-confirm-title" aria-describedby="tw-confirm-message">
        <header className="tw-modal-head">
          <h2 id="tw-confirm-title">{action.title}</h2>
          <button className="tw-icon-plain" type="button" onClick={onCancel} disabled={busy} aria-label="关闭" title="关闭"><X size={18} /></button>
        </header>
        <div className="tw-confirm-body">
          <span className={`tw-confirm-icon${danger ? " is-danger" : ""}`}><AlertTriangle size={20} /></span>
          <p id="tw-confirm-message">{action.message}</p>
        </div>
        <footer className="tw-modal-foot">
          <button ref={cancelRef} className="tw-btn" type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button className={`tw-btn ${danger ? "tw-btn-danger" : "tw-btn-primary"}`} type="button" onClick={() => void onConfirm()} disabled={busy}>{busy ? "正在处理…" : action.confirmLabel}</button>
        </footer>
      </div>
    </div>
  );
}

export default App;
