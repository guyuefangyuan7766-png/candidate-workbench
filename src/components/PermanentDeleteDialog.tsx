import { AlertTriangle, LoaderCircle, RefreshCw, ShieldAlert, Trash2, X } from "lucide-react";
import type { PermanentDeletePreview } from "../api";

export type PermanentDeleteEntity = "candidate" | "position";

interface PermanentDeleteDialogProps {
  entity: PermanentDeleteEntity;
  requestedCount: number;
  preview: PermanentDeletePreview | null;
  loading: boolean;
  committing: boolean;
  error: string;
  onCancel: () => void;
  onRetry: () => void;
  onConfirm: () => void;
}

function impactSummary(impact: unknown) {
  if (typeof impact === "string") return impact;
  if (!impact || typeof impact !== "object") return "服务端已重新校验归档状态、版本和关联影响。";
  const entries = Object.entries(impact as Record<string, unknown>)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 4);
  return entries.length ? entries.map(([key, value]) => `${key}：${String(value)}`).join("；") : "服务端已重新校验归档状态、版本和关联影响。";
}

export function PermanentDeleteDialog({ entity, requestedCount, preview, loading, committing, error, onCancel, onRetry, onConfirm }: PermanentDeleteDialogProps) {
  const candidateMode = entity === "candidate";
  const count = candidateMode ? preview?.candidate_count ?? requestedCount : preview?.position_count ?? requestedCount;
  const affectedCandidateCount = preview?.affected_candidate_count ?? 0;
  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !loading && !committing && onCancel()}>
      <div className="modal permanent-delete-modal" role="alertdialog" aria-modal="true" aria-label={candidateMode ? "永久删除候选人" : "永久删除职位"}>
        <header className="modal-header">
          <div><p className="drawer-kicker danger-kicker">高风险操作</p><h2>{candidateMode ? "永久删除候选人" : "永久删除职位"}</h2></div>
          <button className="icon-button" type="button" onClick={onCancel} disabled={loading || committing} aria-label="关闭" title="关闭"><X size={19} /></button>
        </header>
        <div className="modal-body permanent-delete-body">
          <span className="delete-warning-icon">{loading ? <LoaderCircle className="spin" size={23} /> : <ShieldAlert size={24} />}</span>
          <div className="delete-warning-copy">
            <strong>{loading ? "正在生成一次性删除预览..." : `将永久删除 ${count} ${candidateMode ? "位候选人" : "个职位"}`}</strong>
            <p>{candidateMode
              ? "这些候选人的档案、敏感信息、完整履历与附件会从当前应用数据库中物理删除，应用内无法恢复。"
              : `职位主档和候选人职位关系会删除；${affectedCandidateCount} 位关联候选人的档案、附件、备注和人才库关系均会保留。`}</p>
          </div>

          {candidateMode ? <div className="delete-scope-list" aria-label="候选人删除范围"><span>主档、联系方式与照片地址</span><span>备注、活动与职位/人才库关系</span><span>履历、偏好、来源、评估与授权</span><span>附件元数据、全文索引与物理文件</span></div> : <div className="delete-scope-list" aria-label="职位删除范围"><span>职位主记录与从属记录</span><span>候选人与职位的关联关系</span><span>为受影响候选人写入删除活动</span><span>候选人档案和人才库完整保留</span></div>}

          {preview && <div className="delete-preview-note"><strong>服务端影响预览</strong><span>{impactSummary(preview.impact)}</span><small>令牌有效至 {new Date(preview.expires_at).toLocaleString("zh-CN", { hour12: false })}，且只能使用一次。</small></div>}
          <div className="delete-boundary-note"><ShieldAlert size={15} /><span>此操作仅影响当前应用数据库，不会删除北森等来源系统中的数据、既有导出副本或历史数据库备份。永久删除后不提供撤销。</span></div>
          {error && <div className="delete-preview-error" role="alert"><AlertTriangle size={15} /><span>{error}</span><button className="button secondary-button" type="button" onClick={onRetry} disabled={loading || committing}><RefreshCw size={14} />重新预览</button></div>}
        </div>
        <footer className="modal-footer">
          <button className="button secondary-button" type="button" onClick={onCancel} disabled={loading || committing}>取消</button>
          <button className="button danger-button" type="button" onClick={onConfirm} disabled={!preview || loading || committing}><Trash2 size={16} />{committing ? "正在永久删除..." : `确认永久删除 ${count} ${candidateMode ? "人" : "个职位"}`}</button>
        </footer>
      </div>
    </div>
  );
}
