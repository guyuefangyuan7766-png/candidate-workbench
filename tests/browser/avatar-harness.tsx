import { createRoot } from "react-dom/client";
import { CandidateAvatar } from "../../src/components/CandidateAvatar";
import { TwAvatar } from "../../src/views/TwAvatar";
import "../../src/styles.css";
import "../../src/workspace.css";

const candidates = {
  noPhoto: {
    id: "avatar-no-photo",
    name: "无图候选人",
    has_photo: false,
    updated_at: "2026-09-17T00:00:00.000Z",
  },
  loading: {
    id: "avatar-loading",
    name: "加载候选人",
    has_photo: true,
    updated_at: "2026-09-17T00:00:00.000Z",
  },
  success: {
    id: "avatar-success",
    name: "成功候选人",
    has_photo: true,
    updated_at: "2026-09-17T00:00:00.000Z",
  },
  failure: {
    id: "avatar-failure",
    name: "失败候选人",
    has_photo: true,
    updated_at: "2026-09-17T00:00:00.000Z",
  },
};

function AvatarCase({
  component,
  state,
}: {
  component: "candidate" | "tw";
  state: keyof typeof candidates;
}) {
  const label = `${component === "candidate" ? "CandidateAvatar" : "TwAvatar"} · ${state}`;
  return (
    <div
      data-avatar-case={`${component}-${state}`}
      data-avatar-component={component}
      data-avatar-state={state}
      style={{
        display: "flex",
        width: 180,
        alignItems: "center",
        gap: 12,
        padding: 12,
        border: "1px solid #dee0e3",
        borderRadius: 8,
        background: "#ffffff",
        color: "#434a54",
        fontSize: 13,
      }}
    >
      <span>{label}</span>
      {component === "candidate" ? (
        <CandidateAvatar candidate={candidates[state]} />
      ) : (
        <TwAvatar candidate={candidates[state]} />
      )}
    </div>
  );
}

function Harness() {
  return (
    <main
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, max-content)",
        gap: 12,
        padding: 24,
        background: "#f5f6f7",
      }}
    >
      {(["candidate", "tw"] as const).flatMap((component) =>
        (["noPhoto", "loading", "success", "failure"] as const).map((state) => (
          <AvatarCase component={component} state={state} key={`${component}-${state}`} />
        )),
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
