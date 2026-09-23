import {
  BriefcaseBusiness,
  ChevronRight,
  FileUp,
  Folder,
  FolderKanban,
  Plus,
  UserRound,
  UserRoundX,
  UsersRound,
} from "lucide-react";
import type { Candidate, DashboardData, Position } from "../types";
import { formatDate } from "../utils";
import { TwAvatar } from "../views/TwAvatar";

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

/* 设计图 01：页头（标题 + 日期 + 三个动作）+ 四个内联指标 + 两列分布 + 最近更新人才 / 职位。 */
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
    return (
      <section className="tw-page" aria-busy="true" aria-label="人才资产概览">
        <header className="tw-page-head"><h1>人才资产概览</h1></header>
        <div className="tw-cards tw-cards-4 tw-overview-cards">
          {[0, 1, 2, 3].map((item) => <div className="tw-metric tw-skeleton-block" key={item} style={{ height: 96 }} />)}
        </div>
        <div className="tw-overview-grid">
          <div className="tw-card tw-skeleton-block" style={{ height: 320 }} />
          <div className="tw-card tw-skeleton-block" style={{ height: 320 }} />
        </div>
      </section>
    );
  }

  const talentSummary = data.talent_summary ?? {
    by_pool: [], by_education: [], by_job_seeking_status: [], unassigned_pool_count: data.totals.active,
  };
  const maxPool = Math.max(...talentSummary.by_pool.map((item) => item.count), 1);
  const maxSource = Math.max(...data.by_source.map((item) => item.count), 1);
  const stats = [
    { label: "在库人才", value: data.totals.active, icon: UserRound, action: onOpenCandidates },
    { label: "人才库分组（使用中）", value: talentSummary.by_pool.length, icon: Folder, action: onOpenTalentPools },
    { label: "招聘中职位", value: data.position_totals.open, icon: BriefcaseBusiness, action: onOpenPositions },
    { label: "未分组人才", value: talentSummary.unassigned_pool_count, icon: UserRoundX, action: onOpenUngroupedCandidates },
  ];
  const now = new Date();
  const todayLabel = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;

  return (
    <section className="tw-page" aria-label="人才资产概览">
      <header className="tw-page-head">
        <div className="tw-page-headline">
          <h1>人才资产概览</h1>
          <span className="tw-page-date">{todayLabel}</span>
        </div>
        <div className="tw-page-actions">
          <button className="tw-btn tw-btn-primary" type="button" onClick={onCreateCandidate}><Plus size={16} />新增候选人</button>
          <button className="tw-btn" type="button" onClick={onImport}><FileUp size={16} />导入候选人</button>
          <button className="tw-btn" type="button" onClick={onCreatePosition}><BriefcaseBusiness size={16} />新增职位</button>
        </div>
      </header>

      <div className="tw-cards tw-cards-4 tw-overview-cards" aria-label="关键统计">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <button className="tw-metric tw-metric-link" type="button" key={stat.label} onClick={stat.action}>
              <span className="tw-metric-icon"><Icon size={34} /></span>
              <span className="tw-metric-body"><span>{stat.label}</span><strong>{stat.value}</strong></span>
            </button>
          );
        })}
      </div>

      <div className="tw-overview-grid">
        <section className="tw-card">
          <header className="tw-card-head">
            <h2>人才库分布</h2>
            <button className="tw-card-link" type="button" onClick={onOpenTalentPools}>查看全部<ChevronRight size={15} /></button>
          </header>
          <div className="tw-card-body">
            {talentSummary.by_pool.length ? (
              <div className="tw-bars">
                {talentSummary.by_pool.slice(0, 5).map((item) => (
                  <div className="tw-bar-row" key={item.id}>
                    <span className="tw-bar-label" title={item.name}>{item.name}</span>
                    <span className="tw-bar-track"><span className="tw-bar-fill" style={{ width: `${Math.max((item.count / maxPool) * 100, item.count ? 6 : 0)}%` }} /></span>
                    <span className="tw-bar-value">{item.count}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="tw-empty-sm"><FolderKanban size={22} /><span>暂无人才库分组</span></div>
            )}
          </div>
        </section>

        <section className="tw-card">
          <header className="tw-card-head">
            <h2>有效来源分布</h2>
            <button className="tw-card-link" type="button" onClick={onOpenCandidates}>查看全部<ChevronRight size={15} /></button>
          </header>
          <div className="tw-card-body">
            {data.by_source.length ? (
              <div className="tw-bars">
                {data.by_source.slice(0, 5).map((item) => (
                  <div className="tw-bar-row" key={item.source}>
                    <span className="tw-bar-label" title={item.source || "未设置"}>{item.source || "未设置"}</span>
                    <span className="tw-bar-track"><span className="tw-bar-fill" style={{ width: `${Math.max((item.count / maxSource) * 100, item.count ? 6 : 0)}%` }} /></span>
                    <span className="tw-bar-value">{item.count}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="tw-empty-sm"><UsersRound size={22} /><span>暂无来源数据</span></div>
            )}
          </div>
        </section>

        <section className="tw-card">
          <header className="tw-card-head">
            <h2>最近更新人才</h2>
            <button className="tw-card-link" type="button" onClick={onOpenCandidates}>查看全部<ChevronRight size={15} /></button>
          </header>
          <div className="tw-card-body">
            {data.recent_candidates.length ? (
              <div className="tw-recent">
                {data.recent_candidates.slice(0, 5).map((candidate) => (
                  <button className="tw-recent-row" type="button" key={candidate.id} onClick={() => onOpenCandidate(candidate)}>
                    <TwAvatar candidate={candidate} size={52} />
                    <span className="tw-recent-main">
                      <strong>{candidate.name}</strong>
                      <small>{candidate.current_title || "最近职位待补充"}{candidate.current_company ? ` · ${candidate.current_company}` : ""}</small>
                    </span>
                    <time dateTime={candidate.updated_at}>{formatDate(candidate.updated_at)}</time>
                  </button>
                ))}
              </div>
            ) : (
              <div className="tw-empty-sm"><UsersRound size={22} /><span>暂无候选人数据</span></div>
            )}
          </div>
        </section>

        <section className="tw-card">
          <header className="tw-card-head">
            <h2>最近更新职位</h2>
            <button className="tw-card-link" type="button" onClick={onOpenPositions}>查看全部<ChevronRight size={15} /></button>
          </header>
          <div className="tw-card-body">
            {data.recent_positions.length ? (
              <div className="tw-recent tw-recent-positions">
                {data.recent_positions.slice(0, 5).map((position) => (
                  <button className="tw-recent-row" type="button" key={position.id} onClick={() => onOpenPosition(position)}>
                    <span className="tw-object-icon"><BriefcaseBusiness size={19} /></span>
                    <span className="tw-recent-main">
                      <strong>{position.title}</strong>
                      <small>{[position.department, position.location].filter(Boolean).join(" · ") || "信息待补充"}</small>
                    </span>
                    <time dateTime={position.updated_at}>{formatDate(position.updated_at)}</time>
                  </button>
                ))}
              </div>
            ) : (
              <div className="tw-empty-sm"><BriefcaseBusiness size={22} /><span>暂无职位</span></div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
