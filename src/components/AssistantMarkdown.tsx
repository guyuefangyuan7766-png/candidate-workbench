import { Fragment } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  isExternalMarkdownUrl,
  sanitizeMarkdownUrl,
  transformAssistantMarkdownUrl,
} from "../markdownUrlPolicy";

interface AssistantMarkdownProps {
  content: string;
}

const assistantMarkdownComponents: Components = {
  a({ children, href, title }) {
    const safeHref = sanitizeMarkdownUrl(href ?? "");
    if (!safeHref) return <Fragment>{children}</Fragment>;

    const external = isExternalMarkdownUrl(safeHref);
    return (
      <a
        href={safeHref}
        title={title}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
      >
        {children}
      </a>
    );
  },
  img({ alt }) {
    return <span className="assistant-markdown-image-alt">{alt || "图片"}</span>;
  },
  table({ children }) {
    return (
      <div className="assistant-markdown-table-scroll" role="region" aria-label="表格内容" tabIndex={0}>
        <table>{children}</table>
      </div>
    );
  },
};

export function AssistantMarkdown({ content }: AssistantMarkdownProps) {
  return (
    <div className="assistant-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={assistantMarkdownComponents}
        urlTransform={transformAssistantMarkdownUrl}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
