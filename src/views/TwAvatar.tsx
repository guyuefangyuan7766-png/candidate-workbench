import { useState } from "react";
import type { Candidate } from "../types";
import { initials } from "../utils";

/* 设计图头像：40px（列表）与 84px（详情）圆角方形，缺失时回退姓名首字。 */
export function TwAvatar({ candidate, size = 40 }: { candidate: Pick<Candidate, "id" | "name" | "has_photo" | "updated_at">; size?: number }) {
  const source = candidate.has_photo
    ? `/api/candidates/${encodeURIComponent(candidate.id)}/avatar?v=${encodeURIComponent(candidate.updated_at)}`
    : null;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const dimension = size >= 64 ? Math.round(size / 2) : size;
  const label = size >= 64 ? initials(candidate.name) : initials(candidate.name).slice(-1);

  return (
    <span className="tw-avatar" style={{ width: size, height: size }} aria-hidden="true">
      {source && failedSource !== source ? (
        <img
          src={source}
          alt=""
          width={dimension}
          height={dimension}
          loading={size >= 64 ? "eager" : "lazy"}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedSource(source)}
        />
      ) : label}
    </span>
  );
}
