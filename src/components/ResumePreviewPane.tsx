import { useEffect, useMemo, useState } from "react";
import { Download, ExternalLink, FileWarning } from "lucide-react";
import type { CandidateAttachment } from "../types";

const ORIGIN_TYPE = "resume_origin";
const TEXTUAL_MIME = new Set(["text/plain", "application/json"]);

function contentUrl(attachmentId: string) {
  return `/api/attachments/${encodeURIComponent(attachmentId)}/content`;
}

function downloadUrl(attachment: CandidateAttachment) {
  return attachment.download_url || `/api/attachments/${encodeURIComponent(attachment.id)}/download`;
}

function labelOf(attachment: CandidateAttachment) {
  return attachment.attachment_type === ORIGIN_TYPE ? "原始简历" : "标准简历";
}

interface Props {
  attachments: CandidateAttachment[];
  loading: boolean;
  error: string;
}

/**
 * 档案左侧的简历预览。优先展示候选人自己上传的原始简历（origin），
 * 没有原件时退回标准简历。原件真实类型以入库时按魔数判定的 MIME 为准。
 */
export function ResumePreviewPane({ attachments, loading, error }: Props) {
  const resumes = useMemo(
    () => attachments.filter((item) => item.attachment_type === ORIGIN_TYPE || item.attachment_type === "resume"),
    [attachments],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [textBody, setTextBody] = useState<string | null>(null);
  const [textError, setTextError] = useState("");

  useEffect(() => {
    const preferred = resumes.find((item) => item.attachment_type === ORIGIN_TYPE) ?? resumes[0];
    setSelectedId(preferred?.id ?? null);
  }, [resumes]);

  const current = resumes.find((item) => item.id === selectedId) ?? resumes[0] ?? null;
  const mime = current?.mime_type ?? "";

  useEffect(() => {
    setTextBody(null);
    setTextError("");
    if (!current || !TEXTUAL_MIME.has(mime)) return;
    let cancelled = false;
    fetch(contentUrl(current.id))
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((body) => {
        if (!cancelled) setTextBody(body.slice(0, 200000));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setTextError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [current, mime]);

  if (loading) {
    return (
      <aside className="tw-resume-pane" aria-label="简历预览">
        <div className="tw-resume-empty">正在加载简历…</div>
      </aside>
    );
  }

  if (error) {
    return (
      <aside className="tw-resume-pane" aria-label="简历预览">
        <div className="tw-resume-empty" role="alert">{error}</div>
      </aside>
    );
  }

  if (!current) {
    return (
      <aside className="tw-resume-pane" aria-label="简历预览">
        <div className="tw-resume-empty">
          <FileWarning size={20} />
          <span>这位候选人没有可用简历</span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="tw-resume-pane" aria-label="简历预览">
      <div className="tw-resume-toolbar">
        {resumes.length > 1 ? (
          <div className="tw-resume-tabs" role="tablist" aria-label="简历版本">
            {resumes.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={item.id === current.id}
                className={item.id === current.id ? "active" : ""}
                onClick={() => setSelectedId(item.id)}
              >
                {labelOf(item)}
              </button>
            ))}
          </div>
        ) : (
          <strong className="tw-resume-title">{labelOf(current)}</strong>
        )}
        <span className="tw-resume-meta">{current.original_filename}</span>
        <a className="tw-icon-plain" href={contentUrl(current.id)} target="_blank" rel="noreferrer" title="在新窗口打开" aria-label="在新窗口打开">
          <ExternalLink size={16} />
        </a>
        <a className="tw-icon-plain" href={downloadUrl(current)} download title="下载" aria-label="下载">
          <Download size={16} />
        </a>
      </div>
      <div className="tw-resume-frame">
        {mime === "application/pdf" ? (
          <iframe title="原始简历预览" src={contentUrl(current.id)} />
        ) : mime.startsWith("image/") ? (
          <img src={contentUrl(current.id)} alt="简历图片" />
        ) : mime === "text/html" ? (
          <iframe title="原始简历预览" src={contentUrl(current.id)} sandbox="" referrerPolicy="no-referrer" />
        ) : TEXTUAL_MIME.has(mime) ? (
          textError ? (
            <div className="tw-resume-empty" role="alert">文本读取失败：{textError}</div>
          ) : (
            <pre className="tw-resume-text">{textBody ?? "正在读取文本…"}</pre>
          )
        ) : (
          <div className="tw-resume-empty">
            <FileWarning size={20} />
            <span>该格式无法内嵌预览（{mime || "未知类型"}）</span>
            <a className="tw-btn" href={downloadUrl(current)} download>下载原件</a>
          </div>
        )}
      </div>
    </aside>
  );
}
