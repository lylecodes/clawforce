import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "../api/types";

type TaskCardProps = {
  task: Task;
  onClick: (task: Task) => void;
};

const PRIORITY_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  P0: { bg: "bg-cf-accent-red/15", text: "text-cf-accent-red", label: "P0" },
  P1: { bg: "bg-cf-accent-orange/15", text: "text-cf-accent-orange", label: "P1" },
  P2: { bg: "bg-cf-accent-blue/15", text: "text-cf-accent-blue", label: "P2" },
  P3: { bg: "bg-cf-bg-tertiary", text: "text-cf-text-muted", label: "P3" },
  // Word-form aliases (tasks created via API may use "critical"/"high"/"medium"/"low")
  critical: { bg: "bg-cf-accent-red/15", text: "text-cf-accent-red", label: "Critical" },
  high: { bg: "bg-cf-accent-orange/15", text: "text-cf-accent-orange", label: "High" },
  medium: { bg: "bg-cf-accent-blue/15", text: "text-cf-accent-blue", label: "Medium" },
  low: { bg: "bg-cf-bg-tertiary", text: "text-cf-text-muted", label: "Low" },
};

const INITIATIVE_COLORS = [
  "#58a6ff",
  "#3fb950",
  "#d29922",
  "#f85149",
  "#bc8cff",
  "#f0883e",
  "#a5d6ff",
];

function getInitiativeColor(department?: string): string {
  if (!department) return "#30363d";
  let hash = 0;
  for (let i = 0; i < department.length; i++) {
    hash = department.charCodeAt(i) + ((hash << 5) - hash);
  }
  return INITIATIVE_COLORS[Math.abs(hash) % INITIATIVE_COLORS.length];
}

export function TaskCard({ task, onClick }: TaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    borderLeftColor: getInitiativeColor(task.department),
  };

  const priority = PRIORITY_STYLES[task.priority] ?? PRIORITY_STYLES.P3;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onClick(task)}
      className={`bg-cf-bg-secondary border border-cf-border border-l-[3px] rounded-md p-3 cursor-grab active:cursor-grabbing hover:border-cf-text-muted transition-colors group ${
        isDragging ? "opacity-50 shadow-lg" : ""
      }`}
    >
      {/* Title + Priority */}
      <div className="flex items-start gap-2 mb-2">
        <p className="text-xs text-cf-text-primary font-medium flex-1 line-clamp-2 group-hover:text-cf-accent-blue transition-colors">
          {task.title}
        </p>
        <span
          className={`text-xxs px-1.5 py-0.5 rounded font-bold shrink-0 ${priority.bg} ${priority.text}`}
        >
          {priority.label}
        </span>
      </div>

      {/* Meta row */}
      <div className="flex items-center gap-2 text-xxs text-cf-text-muted">
        {task.assignedTo && (
          <span className="flex items-center gap-1">
            <span className="w-4 h-4 rounded-full bg-cf-bg-tertiary border border-cf-border flex items-center justify-center text-[9px] font-bold text-cf-text-secondary">
              {task.assignedTo.charAt(0).toUpperCase()}
            </span>
            <span className="truncate max-w-[80px]">{task.assignedTo}</span>
          </span>
        )}
        {task.department && (
          <span className="truncate opacity-70">{task.department}</span>
        )}
        <span className="ml-auto font-mono opacity-60">
          {task.id.slice(0, 7)}
        </span>
      </div>
    </div>
  );
}

/** Non-draggable variant for overlays */
export function TaskCardOverlay({ task }: { task: Task }) {
  const priority = PRIORITY_STYLES[task.priority] ?? PRIORITY_STYLES.P3;

  return (
    <div
      className="bg-cf-bg-secondary border border-cf-accent-blue border-l-[3px] rounded-md p-3 shadow-xl opacity-90 w-[280px]"
      style={{ borderLeftColor: getInitiativeColor(task.department) }}
    >
      <div className="flex items-start gap-2 mb-2">
        <p className="text-xs text-cf-text-primary font-medium flex-1 line-clamp-2">
          {task.title}
        </p>
        <span
          className={`text-xxs px-1.5 py-0.5 rounded font-bold shrink-0 ${priority.bg} ${priority.text}`}
        >
          {priority.label}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xxs text-cf-text-muted">
        {task.assignedTo && (
          <span className="truncate">{task.assignedTo}</span>
        )}
      </div>
    </div>
  );
}
