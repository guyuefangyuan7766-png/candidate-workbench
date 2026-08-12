import { BriefcaseBusiness, MapPin } from "lucide-react";
import { useState } from "react";
import { STAGES, type Candidate, type CandidateStage } from "../types";
import { CandidateAvatar } from "./CandidateAvatar";

interface PipelineBoardProps {
  candidates: Candidate[];
  onOpen: (candidate: Candidate) => void;
  onMove: (candidate: Candidate, stage: CandidateStage) => void;
}

export function PipelineBoard({ candidates, onOpen, onMove }: PipelineBoardProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [targetStage, setTargetStage] = useState<CandidateStage | null>(null);

  return (
    <div className="kanban-scroll">
      <div className="kanban-board">
        {STAGES.map((stage) => {
          const stageCandidates = candidates.filter((candidate) => candidate.stage === stage);
          const draggingCandidate = candidates.find((candidate) => candidate.id === draggingId);
          const canAcceptDrop = Boolean(draggingCandidate && !draggingCandidate.archived_at);
          return (
            <section
              className={`kanban-column ${targetStage === stage ? "is-drop-target" : ""}`}
              key={stage}
              onDragOver={(event) => {
                if (!canAcceptDrop) return;
                event.preventDefault();
                setTargetStage(stage);
              }}
              onDragLeave={() => setTargetStage(null)}
              onDrop={(event) => {
                event.preventDefault();
                const id = event.dataTransfer.getData("text/candidate-id") || draggingId;
                const candidate = candidates.find((item) => item.id === id);
                if (candidate && !candidate.archived_at && candidate.stage !== stage) onMove(candidate, stage);
                setDraggingId(null);
                setTargetStage(null);
              }}
            >
              <header className="kanban-header">
                <div><span className={`stage-dot dot-${stage}`}></span><h3>{stage}</h3></div>
                <span>{stageCandidates.length}</span>
              </header>
              <div className="kanban-items">
                {stageCandidates.map((candidate) => (
                  <article
                    className={`candidate-card${draggingId === candidate.id ? " is-dragging" : ""}${candidate.archived_at ? " is-archived" : ""}`}
                    key={candidate.id}
                    draggable={!candidate.archived_at}
                    onDragStart={(event) => {
                      if (candidate.archived_at) {
                        event.preventDefault();
                        return;
                      }
                      setDraggingId(candidate.id);
                      event.dataTransfer.setData("text/candidate-id", candidate.id);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setTargetStage(null);
                    }}
                    onClick={() => onOpen(candidate)}
                  >
                    <div className="candidate-card-head">
                      <CandidateAvatar candidate={candidate} />
                      <div>
                        <strong>{candidate.name}</strong>
                        <span>{candidate.owner}</span>
                      </div>
                    </div>
                    <div className="candidate-card-role">
                      <BriefcaseBusiness size={14} />
                      <span>{candidate.current_title || "职位待补充"}</span>
                    </div>
                    <div className="candidate-card-meta">
                      <span><MapPin size={13} />{candidate.location || "-"}</span>
                      <span>{candidate.years_experience ? `${candidate.years_experience}年` : "-"}</span>
                    </div>
                    <div className="candidate-card-tags">
                      {candidate.tags.slice(0, 2).map((tag) => <span className="tag" key={tag}>{tag}</span>)}
                    </div>
                  </article>
                ))}
                {!stageCandidates.length && <div className="kanban-empty">暂无候选人</div>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
