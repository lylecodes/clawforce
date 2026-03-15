import { useState } from "react";
import type { Task, TaskState } from "../api/types";

type TaskDetailPanelProps = {
  task: Task;
  onClose: () => void;
};

const STATE_LABELS: Record<TaskState, { label: string; color: string }> = {
  OPEN: { label: "Open", color: "bg-cf-accent-blue/15 text-cf-accent-blue" },
  ASSIGNED: { label: "Assigned", color: "bg-cf-accent-blue/15 text-cf-accent-blue" },
  IN_PROGRESS: { label: "In Progress", color: "bg-cf-accent-orange/15 text-cf-accent-orange" },
  REVIEW: { label: "Review", color: "bg-cf-accent-purple/15 text-cf-accent-purple" },
  BLOCKED: { label: "Blocked", color: "bg-cf-accent-red/15 text-cf-accent-red" },
  DONE: { label: "Done", color: "bg-cf-accent-green/15 text-cf-accent-green" },
  CANCELLED: { label: "Cancelled", color: "bg-cf-bg-tertiary text-cf-text-muted" },
};

const PRIORITY_STYLES: Record<string, { bg: string; text: string }> = {
  P0: { bg: "bg-cf-accent-red/15", text: "text-cf-accent-red" },
  P1: { bg: "bg-cf-accent-orange/15", text: "text-cf-accent-orange" },
  P2: { bg: "bg-cf-accent-blue/15", text: "text-cf-accent-blue" },
  P3: { bg: "bg-cf-bg-tertiary", text: "text-cf-text-muted" },
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TaskDetailPanel({ task, onClose }: TaskDetailPanelProps) {
  const [isClosing, setIsClosing] = useState(false);

  const stateInfo = STATE_LABELS[task.state] ?? STATE_LABELS.OPEN;
  const priority = PRIORITY_STYLES[task.priority] ?? PRIORITY_STYLES.P3;

  function handleClose() {
    setIsClosing(true);
    setTimeout(onClose, 200);
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/40 z-40 transition-opacity ${
          isClosing ? "opacity-0" : "opacity-100"
        }`}
        onClick={handleClose}
      />

      {/* Panel */}
      <div
        className={`fixed top-0 right-0 h-full w-full max-w-[480px] bg-cf-bg-secondary border-l border-cf-border z-50 flex flex-col shadow-2xl transition-transform ${
          isClosing ? "translate-x-full" : "translate-x-0"
        }`}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-cf-border-muted flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span
                className={`text-xxs px-1.5 py-0.5 rounded font-bold ${priority.bg} ${priority.text}`}
              >
                {task.priority}
              </span>
              <span
                className={`text-xxs px-1.5 py-0.5 rounded font-medium ${stateInfo.color}`}
              >
                {stateInfo.label}
              </span>
              <span className="text-xxs text-cf-text-muted font-mono ml-auto">
                {task.id.slice(0, 12)}
              </span>
            </div>
            <h2 className="text-sm font-semibold text-cf-text-primary leading-snug">
              {task.title}
            </h2>
          </div>
          <button
            onClick={handleClose}
            className="text-cf-text-muted hover:text-cf-text-primary transition-colors p-1 -mr-1 -mt-1"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Description */}
          {task.description && (
            <section>
              <h3 className="text-xxs uppercase tracking-wider text-cf-text-muted font-semibold mb-2">
                Description
              </h3>
              <p className="text-xs text-cf-text-secondary leading-relaxed whitespace-pre-wrap">
                {task.description}
              </p>
            </section>
          )}

          {/* Details grid */}
          <section>
            <h3 className="text-xxs uppercase tracking-wider text-cf-text-muted font-semibold mb-2">
              Details
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <DetailItem label="Assigned To" value={task.assignedTo ?? "Unassigned"} />
              <DetailItem label="Department" value={task.department ?? "—"} />
              <DetailItem label="Team" value={task.team ?? "—"} />
              <DetailItem label="Priority" value={task.priority} />
              <DetailItem label="Created" value={formatDate(task.createdAt)} />
              <DetailItem label="Updated" value={formatDate(task.updatedAt)} />
            </div>
          </section>

          {/* Goal link */}
          {task.goalId && (
            <section>
              <h3 className="text-xxs uppercase tracking-wider text-cf-text-muted font-semibold mb-2">
                Linked Goal
              </h3>
              <div className="bg-cf-bg-tertiary border border-cf-border rounded px-3 py-2">
                <span className="text-xs text-cf-accent-blue font-mono">
                  {task.goalId}
                </span>
              </div>
            </section>
          )}

          {/* State history (placeholder) */}
          <section>
            <h3 className="text-xxs uppercase tracking-wider text-cf-text-muted font-semibold mb-2">
              History
            </h3>
            <div className="space-y-2">
              <HistoryEntry
                label={`State set to ${task.state}`}
                time={formatDate(task.updatedAt)}
              />
              <HistoryEntry
                label="Task created"
                time={formatDate(task.createdAt)}
              />
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xxs text-cf-text-muted mb-0.5">{label}</dt>
      <dd className="text-xs text-cf-text-primary">{value}</dd>
    </div>
  );
}

function HistoryEntry({ label, time }: { label: string; time: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-1.5 h-1.5 rounded-full bg-cf-text-muted shrink-0" />
      <span className="text-xs text-cf-text-secondary flex-1">{label}</span>
      <span className="text-xxs text-cf-text-muted font-mono">{time}</span>
    </div>
  );
}
