import { useState } from "react";
import type { Candidate } from "../types";
import { initials } from "../utils";

interface CandidateAvatarProps {
  candidate: Pick<Candidate, "id" | "name" | "has_photo" | "updated_at">;
  size?: "default" | "large";
}

export function CandidateAvatar({ candidate, size = "default" }: CandidateAvatarProps) {
  const source = candidate.has_photo
    ? `/api/candidates/${encodeURIComponent(candidate.id)}/avatar?v=${encodeURIComponent(candidate.updated_at)}`
    : null;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const dimension = size === "large" ? 52 : 32;

  return (
    <span className={`avatar${size === "large" ? " avatar-large" : ""}`} aria-hidden="true">
      {source && failedSource !== source ? (
        <img
          className="avatar-image"
          src={source}
          alt=""
          width={dimension}
          height={dimension}
          loading={size === "large" ? "eager" : "lazy"}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedSource(source)}
        />
      ) : initials(candidate.name)}
    </span>
  );
}
