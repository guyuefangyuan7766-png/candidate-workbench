import { useEffect, useMemo, useState } from "react";
import { Download, ExternalLink, FileWarning, Maximize2, Minimize2 } from "lucide-react";
import type { CandidateAttachment } from "../types";

const ORIGIN_TYPE = "resume_origin";
const TEXTUAL_MIME = new Set(["text/plain", "application/json"]);
// 「隐藏边框」是本地展示偏好，记在浏览器里，刷新后仍生效。
const FRAMELESS_KEY = "tw-resume-frameless";

function contentUrl(attachmentId: string) {
  return `/api/attachments/${encodeURIComponent(attachmentId)}/content`;
}

// 简历保持原始比例，不做"适应宽度/铺满"的强制缩放；
// 隐藏边框时只关掉浏览器查看器自带的深色工具条与缩略图栏。
function frameUrl(attachmentId: string, frameless: boolean) {
  const base = contentUrl(attachmentId);
  return frameless ? `${base}#toolbar=0&navpanes=0` : base;
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
  const [frameless, setFrameless] = useState(() => {
    try {
      return window.localStorage.getItem(FRAMELESS_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(FRAMELESS_KEY, frameless ? "1" : "0");
    } catch {
      /* 隐私模式下写入失败不影响使用 */
    }
  }, [frameless]);

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
    <aside className={`tw-resume-pane${frameless ? " is-frameless" : ""}`} aria-label="简历预览">
      <div className="tw-resume-toolbar">
        {/* 只有一个版本时也渲染同样的切换区（单个页签），保证所有人的工具条结构一致。 */}
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
        <span className="tw-resume-meta">{current.original_filename}</span>
        <a className="tw-icon-plain" href={contentUrl(current.id)} target="_blank" rel="noreferrer" title="在新窗口打开" aria-label="在新窗口打开">
          <ExternalLink size={16} />
        </a>
        <a className="tw-icon-plain" href={downloadUrl(current)} download title="下载" aria-label="下载">
          <Download size={16} />
        </a>
        <button
          className="tw-icon-plain"
          type="button"
          aria-pressed={frameless}
          onClick={() => setFrameless((value) => !value)}
          title={frameless ? "显示边框" : "隐藏边框（铺满显示）"}
          aria-label={frameless ? "显示边框" : "隐藏边框"}
        >
          {frameless ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
      <div className="tw-resume-frame">
        {mime === "application/pdf" ? (
          // key 带上 frameless：只改 URL 片段不会让 iframe 重新加载，
          // 必须重挂载才能让浏览器 PDF 查看器应用 #toolbar=0&navpanes=0。
          <iframe key={frameless ? "frameless" : "framed"} title="原始简历预览" src={frameUrl(current.id, frameless)} />
        ) : mime.startsWith("image/") ? (
          <img src={contentUrl(current.id)} alt="简历图片" />
        ) : mime === "text/html" ? (
          <iframe key={frameless ? "frameless" : "framed"} title="原始简历预览" src={frameUrl(current.id, frameless)} sandbox="" referrerPolicy="no-referrer" />
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
