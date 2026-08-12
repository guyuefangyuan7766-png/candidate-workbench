import {
  POSITION_STATUS_LABELS as STATUS_LABELS,
  type PositionStatus,
} from "../types";

export const POSITION_STATUS_LABELS = STATUS_LABELS;

interface PositionStatusBadgeProps {
  status: PositionStatus;
  archived?: boolean;
}

export function PositionStatusBadge({ status, archived = false }: PositionStatusBadgeProps) {
  if (archived) {
    return <span className="position-status-badge position-status-archived">已归档</span>;
  }

  return (
    <span className={`position-status-badge position-status-${status}`}>
      {POSITION_STATUS_LABELS[status]}
    </span>
  );
}
