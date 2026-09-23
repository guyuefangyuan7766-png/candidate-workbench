import { useEffect, useRef } from "react";
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
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const previousRef = useRef<HTMLElement | null>(null);
  const titleId = "tw-delete-title";
  const describeId = "tw-delete-description";
  useEffect(() => {
    previousRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (previousRef.current?.isConnected) previousRef.current.focus(); };
  }, []);
  useEffect(() => {
    if (loading || committing) return;
    (error ? retryRef.current : cancelRef.current)?.focus();
  }, [loading, committing, error]);
  const scopeItems = candidateMode
    ? ["主档、联系方式与照片地址", "备注、活动与职位/人才库关系", "履历、偏好、来源、评估与授权", "附件元数据、全文索引与物理文件"]
    : ["职位主记录与从属记录", "候选人与职位的关联关系", "为受影响候选人写入删除活动", "候选人档案和人才库完整保留"];
  return (
    <div className="tw-modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !loading && !committing && onCancel()}>
      <section className="tw-modal tw-modal-md tw-delete" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={describeId}>
        <header className="tw-modal-head">
          <div>
            <p className="tw-modal-kicker">高风险操作</p>
            <h2 id={titleId}>{candidateMode ? "永久删除候选人" : "永久删除职位"}</h2>
          </div>
          <button className="tw-icon-plain" type="button" onClick={onCancel} disabled={loading || committing} aria-label="关闭" title="关闭"><X size={18} /></button>
        </header>
        <div className="tw-modal-body tw-delete-body">
          <div className="tw-delete-banner">
            <span className={`tw-delete-icon${loading ? " is-busy" : ""}`}>{loading ? <LoaderCircle className="spin" size={20} /> : <ShieldAlert size={20} />}</span>
            <div className="tw-delete-banner-copy">
              <strong id={describeId}>{loading ? "正在生成一次性删除预览…" : `将永久删除 ${count} ${candidateMode ? "位候选人" : "个职位"}`}</strong>
              <p>{candidateMode
                ? "这些候选人的档案、敏感信息、完整履历与附件会从当前应用数据库中物理删除，应用内无法恢复。"
                : `职位主档和候选人职位关系会删除；${affectedCandidateCount} 位关联候选人的档案、附件、备注和人才库关系均会保留。`}</p>
            </div>
          </div>
          <ul className="tw-delete-scope" aria-label={candidateMode ? "候选人删除范围" : "职位删除范围"}>
            {scopeItems.map((item) => <li key={item}>{item}</li>)}
          </ul>
          {preview && (
            <div className="tw-delete-note">
              <strong>服务端影响预览</strong>
              <span>{impactSummary(preview.impact)}</span>
              <small>令牌有效至 {new Date(preview.expires_at).toLocaleString("zh-CN", { hour12: false })}，且只能使用一次。</small>
            </div>
          )}
          <div className="tw-delete-boundary">
            <ShieldAlert size={15} />
            <span>此操作仅影响当前应用数据库，不会删除北森等来源系统中的数据、既有导出副本或历史数据库备份。永久删除后不提供撤销。</span>
          </div>
          {error && (
            <div className="tw-delete-error" role="alert">
              <AlertTriangle size={15} />
              <span>{error}</span>
              <button ref={retryRef} className="tw-btn tw-btn-sm" type="button" onClick={onRetry} disabled={loading || committing}><RefreshCw size={14} />重新预览</button>
            </div>
          )}
        </div>
        <footer className="tw-modal-foot">
          <button ref={cancelRef} className="tw-btn" type="button" onClick={onCancel} disabled={loading || committing}>取消</button>
          <button className="tw-btn tw-btn-danger" type="button" onClick={onConfirm} disabled={!preview || loading || committing}><Trash2 size={16} />{committing ? "正在永久删除…" : `确认永久删除 ${count} ${candidateMode ? "人" : "个职位"}`}</button>
        </footer>
      </section>
    </div>
  );
}
