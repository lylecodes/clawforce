import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { TaskCard } from "./TaskCard";
import type { Task, TaskState } from "../api/types";

type TaskColumnProps = {
  id: TaskState;
  label: string;
  tasks: Task[];
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onTaskClick: (task: Task) => void;
};

const COLUMN_ACCENT: Record<string, string> = {
  OPEN: "border-cf-accent-blue",
  IN_PROGRESS: "border-cf-accent-orange",
  REVIEW: "border-cf-accent-purple",
  BLOCKED: "border-cf-accent-red",
  DONE: "border-cf-accent-green",
};

export function TaskColumn({
  id,
  label,
  tasks,
  collapsed = false,
  onToggleCollapse,
  onTaskClick,
}: TaskColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });

  const accent = COLUMN_ACCENT[id] ?? "border-cf-border";

  if (collapsed) {
    return (
      <div className="min-w-[60px] flex-shrink-0">
        <button
          onClick={onToggleCollapse}
          className={`w-full bg-cf-bg-secondary border ${accent} border-t-2 rounded-lg p-3 hover:bg-cf-bg-tertiary transition-colors h-full min-h-[200px] flex flex-col items-center gap-2`}
        >
          <span className="text-xxs text-cf-text-secondary font-semibold uppercase tracking-wider [writing-mode:vertical-lr] rotate-180">
            {label}
          </span>
          <span className="text-xxs font-mono text-cf-text-muted bg-cf-bg-tertiary px-1.5 py-0.5 rounded">
            {tasks.length}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      className={`flex-1 min-w-[250px] max-w-[350px] flex flex-col`}
    >
      {/* Column header */}
      <div
        className={`bg-cf-bg-secondary border ${accent} border-t-2 rounded-t-lg px-3 py-2.5 flex items-center justify-between`}
      >
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-cf-text-primary uppercase tracking-wider">
            {label}
          </h3>
          <span className="text-xxs font-mono text-cf-text-muted bg-cf-bg-tertiary px-1.5 py-0.5 rounded">
            {tasks.length}
          </span>
        </div>
        {id === "DONE" && (
          <button
            onClick={onToggleCollapse}
            className="text-xxs text-cf-text-muted hover:text-cf-text-secondary transition-colors"
          >
            Collapse
          </button>
        )}
      </div>

      {/* Drop zone */}
      <div
        ref={setNodeRef}
        className={`flex-1 bg-cf-bg-primary border border-t-0 border-cf-border rounded-b-lg p-2 space-y-2 overflow-y-auto max-h-[calc(100vh-280px)] transition-colors ${
          isOver ? "bg-cf-accent-blue/5 border-cf-accent-blue/30" : ""
        }`}
      >
        <SortableContext
          items={tasks.map((t) => t.id)}
          strategy={verticalListSortingStrategy}
        >
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} onClick={onTaskClick} />
          ))}
        </SortableContext>

        {tasks.length === 0 && (
          <div className="text-center py-8 text-cf-text-muted text-xxs">
            No tasks
          </div>
        )}
      </div>
    </div>
  );
}
