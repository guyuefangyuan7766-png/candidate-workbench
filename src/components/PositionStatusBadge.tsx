import {
  POSITION_STATUS_LABELS as STATUS_LABELS,
  type PositionStatus,
} from "../types";

export const POSITION_STATUS_LABELS = STATUS_LABELS;

interface PositionStatusBadgeProps {
  status: PositionStatus;
  archived?: boolean;
}

/* 设计图 04 徽标：浅底 + 颜色圆点 + 文字。 */
const STATUS_CLASS: Record<PositionStatus, string> = {
  draft: "tw-status-archived",
  open: "tw-status-active",
  paused: "tw-status-warn",
  closed: "tw-status-danger",
};

export function PositionStatusBadge({ status, archived = false }: PositionStatusBadgeProps) {
  if (archived) {
    return <span className="tw-status tw-status-archived"><span className="tw-dot" />已归档</span>;
  }

  return (
    <span className={`tw-status ${STATUS_CLASS[status]}`}>
      <span className="tw-dot" />
      {POSITION_STATUS_LABELS[status]}
    </span>
  );
}
