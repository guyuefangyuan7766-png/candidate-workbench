import {
  ArrowRight,
  BriefcaseBusiness,
  FileUp,
  FolderKanban,
  Plus,
  UserRoundPlus,
  UsersRound,
} from "lucide-react";
import type { Candidate, DashboardData, Position } from "../types";
import { formatDateTime } from "../utils";
import { CandidateAvatar } from "./CandidateAvatar";
import { PositionStatusBadge } from "./PositionStatusBadge";

interface OverviewProps {
  data: DashboardData | null;
  loading?: boolean;
  onOpenCandidate: (candidate: Candidate) => void;
  onOpenPosition: (position: Position) => void;
  onOpenCandidates: () => void;
  onOpenUngroupedCandidates: () => void;
  onOpenPositions: () => void;
  onOpenTalentPools: () => void;
  onCreateCandidate: () => void;
  onCreatePosition: () => void;
  onImport: () => void;
}

export function Overview({
  data,
  loading = false,
  onOpenCandidate,
  onOpenPosition,
  onOpenCandidates,
  onOpenUngroupedCandidates,
  onOpenPositions,
  onOpenTalentPools,
  onCreateCandidate,
  onCreatePosition,
  onImport,
}: OverviewProps) {
  if (loading || !data) {
    return <div className="overview-page" aria-busy="true"><div className="page-title-skeleton skeleton-block" /><div className="stats-grid">{[0, 1, 2, 3].map((item) => <div className="stat-card skeleton-block" key={item} />)}</div><div className="overview-grid"><div className="overview-panel skeleton-block" /><div className="overview-panel skeleton-block" /></div></div>;
  }

  const talentSummary = data.talent_summary ?? {
    by_pool: [], by_education: [], by_job_seeking_status: [], unassigned_pool_count: data.totals.active,
  };
  const maxPool = Math.max(...talentSummary.by_pool.map((item) => item.count), 1);
  const maxSource = Math.max(...data.by_source.map((item) => item.count), 1);
  const stats = [
    { label: "在库人才", value: data.totals.active, detail: "未归档候选人档案", icon: UsersRound, tone: "green", action: onOpenCandidates },
    { label: "人才库分组", value: talentSummary.by_pool.length, detail: "长期人才分类", icon: FolderKanban, tone: "blue", action: onOpenTalentPools },
    { label: "招聘中职位", value: data.position_totals.open, detail: `${data.position_totals.active} 个活跃职位`, icon: BriefcaseBusiness, tone: "amber", action: onOpenPositions },
    { label: "未分组人才", value: talentSummary.unassigned_pool_count, detail: "等待归入人才库", icon: UserRoundPlus, tone: "coral", action: onOpenUngroupedCandidates },
  ];

  return (
    <div className="overview-page">
      <header className="page-heading dashboard-heading">
        <div><p className="eyebrow">人才工作台</p><h1>人才资产概览</h1><p className="page-description">集中查看候选人、人才库分组和关联职位</p></div>
        <div className="page-actions"><button className="button secondary-button" type="button" onClick={onImport}><FileUp size={16} />导入候选人</button><button className="button secondary-button" type="button" onClick={onCreatePosition}><BriefcaseBusiness size={16} />新增职位</button><button className="button primary-button" type="button" onClick={onCreateCandidate}><Plus size={17} />新增候选人</button></div>
      </header>

      <section className="stats-grid" aria-label="关键统计">{stats.map((stat) => { const Icon = stat.icon; return <button className="stat-card" type="button" key={stat.label} onClick={stat.action}><span className={`stat-icon stat-${stat.tone}`}><Icon size={20} /></span><span className="stat-copy"><span>{stat.label}</span><strong>{stat.value}</strong><small>{stat.detail}</small></span><ArrowRight className="stat-arrow" size={16} /></button>; })}</section>

      <div className="overview-grid">
        <section className="overview-panel">
          <header className="section-header"><div><p className="section-kicker">人才分组</p><h2>人才库分布</h2></div><button className="text-action" type="button" onClick={onOpenTalentPools}>管理人才库<ArrowRight size={15} /></button></header>
          <div className="funnel-list talent-distribution-list">{talentSummary.by_pool.slice(0, 7).map((item) => <div className="funnel-row" key={item.id}><span><i className="pool-color" style={{ backgroundColor: item.color }} />{item.name}</span><div className="funnel-track"><span style={{ width: `${Math.max((item.count / maxPool) * 100, item.count ? 8 : 0)}%`, backgroundColor: item.color }} /></div><strong>{item.count}</strong></div>)}{!talentSummary.by_pool.length && <div className="inline-empty"><FolderKanban size={22} /><span>暂无人才库分组</span></div>}</div>
        </section>

        <section className="overview-panel">
          <header className="section-header"><div><p className="section-kicker">人才来源</p><h2>有效来源分布</h2></div><button className="text-action" type="button" onClick={onOpenCandidates}>查看候选人<ArrowRight size={15} /></button></header>
          <div className="funnel-list source-distribution-list">{data.by_source.slice(0, 7).map((item) => <div className="funnel-row" key={item.source}><span>{item.source || "未设置"}</span><div className="funnel-track"><span style={{ width: `${Math.max((item.count / maxSource) * 100, item.count ? 8 : 0)}%` }} /></div><strong>{item.count}</strong></div>)}{!data.by_source.length && <div className="inline-empty"><UsersRound size={22} /><span>暂无来源数据</span></div>}</div>
        </section>

        <section className="overview-panel">
          <header className="section-header"><div><p className="section-kicker">职位关联</p><h2>最近更新职位</h2></div><button className="text-action" type="button" onClick={onOpenPositions}>管理职位<ArrowRight size={15} /></button></header>
          <div className="compact-list">{data.recent_positions.slice(0, 5).map((position) => <button className="compact-list-row" type="button" key={position.id} onClick={() => onOpenPosition(position)}><span className="entity-icon"><BriefcaseBusiness size={17} /></span><span className="compact-list-main"><strong>{position.title}</strong><small>{[position.department, position.location].filter(Boolean).join(" · ") || "信息待补充"}</small></span><PositionStatusBadge status={position.status} archived={Boolean(position.archived_at)} /><span className="count-copy">{position.candidate_count} 人</span></button>)}{!data.recent_positions.length && <div className="inline-empty"><BriefcaseBusiness size={22} /><span>暂无职位</span></div>}</div>
        </section>

        <section className="overview-panel">
          <header className="section-header"><div><p className="section-kicker">人才动态</p><h2>最近更新候选人</h2></div><span className="section-meta">近 7 天 {data.recent_update_count ?? 0} 次更新</span></header>
          <div className="recent-candidate-grid compact-recent-grid">{data.recent_candidates.slice(0, 5).map((candidate) => <button className="recent-candidate" type="button" key={candidate.id} onClick={() => onOpenCandidate(candidate)}><CandidateAvatar candidate={candidate} /><span className="recent-candidate-main"><strong>{candidate.name}</strong><small>{candidate.current_title || "当前职位待补充"}{candidate.current_company ? ` · ${candidate.current_company}` : ""}</small></span><span className="recent-pool-label">{candidate.talent_pools[0]?.name || candidate.source || "未分组"}</span><time>{formatDateTime(candidate.updated_at)}</time></button>)}{!data.recent_candidates.length && <div className="inline-empty"><UsersRound size={22} /><span>暂无候选人数据</span></div>}</div>
        </section>
      </div>
    </div>
  );
}
