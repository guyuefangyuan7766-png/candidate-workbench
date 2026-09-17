import type { ReactNode } from "react";
import {
  BriefcaseBusiness,
  Download,
  FileText,
  FolderKanban,
  Home,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sparkles,
  UsersRound,
  X,
} from "lucide-react";

export type NavPage = "dashboard" | "candidates" | "talent-pools" | "positions" | "position-detail";
export type ToolPageId = "assistant" | "resume-search" | "attachment-parser";

/* 设计图侧栏：208px 主侧栏（收起 72px），品牌区、八个入口、底部工作区说明。 */
const PRIMARY_NAV: Array<{ id: Exclude<NavPage, "position-detail">; label: string; icon: typeof Home }> = [
  { id: "dashboard", label: "工作台", icon: Home },
  { id: "candidates", label: "候选人库", icon: UsersRound },
  { id: "talent-pools", label: "人才库分组", icon: FolderKanban },
  { id: "positions", label: "职位管理", icon: BriefcaseBusiness },
];

const TOOL_NAV: Array<{ id: ToolPageId; label: string; icon: typeof Home }> = [
  { id: "assistant", label: "AI 助手", icon: Sparkles },
  { id: "resume-search", label: "履历检索", icon: Search },
  { id: "attachment-parser", label: "附件解析", icon: FileText },
];

export interface AppShellProps {
  page: NavPage;
  toolPage: ToolPageId | null;
  toolOpen: boolean;
  importOpen?: boolean;
  collapsed: boolean;
  mobileOpen: boolean;
  agentConfigured: boolean;
  title: string;
  onNavigate: (page: Exclude<NavPage, "position-detail">) => void;
  onOpenTool: (tool: ToolPageId) => void;
  onOpenImport: () => void;
  onToggleCollapse: () => void;
  onToggleMobile: () => void;
  children: ReactNode;
  overlays?: ReactNode;
}

export function AppShell(props: AppShellProps) {
  const {
    page, toolPage, toolOpen, importOpen = false, collapsed, mobileOpen, agentConfigured, title,
    onNavigate, onOpenTool, onOpenImport, onToggleCollapse, onToggleMobile, children, overlays,
  } = props;

  return (
    <div className={`tw-app${collapsed ? " is-collapsed" : ""}`}>
      <aside className={`tw-sidebar${mobileOpen ? " is-open" : ""}`} aria-label="主导航">
        <div className="tw-brand">
          <span className="tw-brand-mark">
            <strong>拾才</strong>
            <small>让优秀的人更容易被看见</small>
          </span>
          <button
            className="tw-collapse"
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
            title={collapsed ? "展开侧边栏" : "收起侧边栏"}
            aria-expanded={!collapsed}
          >
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
        <nav className="tw-nav">
          {PRIMARY_NAV.map((item) => {
            const Icon = item.icon;
            const active = !toolOpen && !importOpen && (page === item.id || (item.id === "positions" && page === "position-detail"));
            return (
              <button
                className={`tw-nav-item${active ? " active" : ""}`}
                type="button"
                key={item.id}
                onClick={() => onNavigate(item.id)}
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
                title={collapsed ? item.label : undefined}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
          <span className="tw-nav-sep" />
          <button
            className={`tw-nav-item${importOpen ? " active" : ""}`}
            type="button"
            onClick={onOpenImport}
            aria-label="导入候选人"
            aria-current={importOpen ? "page" : undefined}
            title={collapsed ? "导入候选人" : undefined}
          >
            <Download size={18} />
            <span>导入候选人</span>
          </button>
          {TOOL_NAV.map((item) => {
            const Icon = item.icon;
            const active = toolOpen && !importOpen && toolPage === item.id;
            return (
              <button
                className={`tw-nav-item${active ? " active" : ""}`}
                type="button"
                key={item.id}
                onClick={() => onOpenTool(item.id)}
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
                title={collapsed ? item.label : undefined}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                {item.id === "assistant" && (
                  <small className={`tw-nav-dot${agentConfigured ? " is-online" : ""}`} title={agentConfigured ? "模型网关已配置" : "模型网关未配置"} aria-hidden="true" />
                )}
              </button>
            );
          })}
        </nav>
        <div className="tw-sidebar-foot">
          <div>成为企业的长期人才伙伴</div>
          <div>{new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date())}</div>
        </div>
      </aside>

      <div className="tw-shell">
        <header className="tw-topbar">
          <button
            className="tw-icon-plain"
            type="button"
            onClick={onToggleMobile}
            aria-label={mobileOpen ? "关闭导航" : "打开导航"}
            aria-expanded={mobileOpen}
            title={mobileOpen ? "关闭导航" : "打开导航"}
          >
            {mobileOpen ? <X size={19} /> : <Menu size={19} />}
          </button>
          <span className="tw-topbar-title"><strong>{title}</strong><span>人才资料管理</span></span>
          <span className="tw-chips-spacer" />
          <button className="tw-btn tw-btn-sm" type="button" onClick={() => onOpenTool("assistant")}>
            <Sparkles size={15} />助手
          </button>
        </header>
        <main className="tw-content">{children}</main>
      </div>

      {mobileOpen && <button className="tw-scrim" type="button" onClick={onToggleMobile} aria-label="关闭导航" />}
      {overlays}
    </div>
  );
}
