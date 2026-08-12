import type { CandidateStage } from "../types";
import { stageClass } from "../utils";

interface StageBadgeProps {
  stage: CandidateStage;
}

export function StageBadge({ stage }: StageBadgeProps) {
  return <span className={`stage-badge ${stageClass(stage)}`}>{stage}</span>;
}
