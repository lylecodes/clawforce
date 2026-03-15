import { useState, useMemo, useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "../store";
import { api } from "../api/client";
import { useTasks, type TaskFilters } from "../hooks/useTasks";
import { TaskColumn } from "../components/TaskColumn";
import { TaskCardOverlay } from "../components/TaskCard";
import { TaskDetailPanel } from "../components/TaskDetailPanel";
import { FilterBar } from "../components/FilterBar";
import { CreateTaskModal } from "../components/CreateTaskModal";
import type { Task, TaskState } from "../api/types";

const COLUMN_STATE_MAP: Record<string, TaskState> = {
  OPEN: "OPEN",
  IN_PROGRESS: "IN_PROGRESS",
  REVIEW: "REVIEW",
  BLOCKED: "BLOCKED",
  DONE: "DONE",
};

export function TaskBoard() {
  const activeDomain = useAppStore((s) => s.activeDomain);
  const [filters, setFilters] = useState<TaskFilters>({});
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [collapsedDone, setCollapsedDone] = useState(true);

  const {
    columns,
    isLoading,
    reassignTask,
    createTask,
    isCreating,
    tasks,
  } = useTasks(filters);

  // Fetch agents for filter dropdowns
  const { data: agentsData } = useQuery({
    queryKey: ["agents", activeDomain],
    queryFn: () => api.getAgents(activeDomain!),
    enabled: !!activeDomain,
    staleTime: 60_000,
  });

  const agentIds = useMemo(
    () => (agentsData ?? []).map((a) => a.id),
    [agentsData],
  );

  const departments = useMemo(() => {
    const depts = new Set<string>();
    for (const t of tasks) {
      if (t.department) depts.add(t.department);
    }
    return Array.from(depts).sort();
  }, [tasks]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const id = event.active.id as string;
      const task = tasks.find((t) => t.id === id) ?? null;
      setActiveTask(task);
    },
    [tasks],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveTask(null);
      const { active, over } = event;
      if (!over) return;

      const taskId = active.id as string;
      const targetColumnId = over.id as string;

      // Determine target state from column id
      const targetState = COLUMN_STATE_MAP[targetColumnId];
      if (!targetState) return;

      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;

      // Only reassign if the column actually changed
      const currentCol = task.state === "ASSIGNED" ? "OPEN" : task.state;
      if (currentCol === targetColumnId) return;

      // Use reassign endpoint (backend handles state transition)
      reassignTask({
        taskId,
        newAssignee: task.assignedTo ?? "",
      });
    },
    [tasks, reassignTask],
  );

  const handleCreateTask = useCallback(
    (data: Record<string, unknown>) => {
      createTask(data);
      setShowCreateModal(false);
    },
    [createTask],
  );

  if (!activeDomain) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="text-center">
          <p className="text-cf-text-secondary text-lg mb-2">
            No domain selected
          </p>
          <p className="text-cf-text-muted text-sm">
            Select a domain from the switcher above to view the task board.
          </p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 bg-cf-bg-secondary rounded animate-pulse" />
        <div className="flex gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex-1 h-[400px] bg-cf-bg-secondary rounded animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <FilterBar
        filters={filters}
        onFiltersChange={setFilters}
        onCreateTask={() => setShowCreateModal(true)}
        agents={agentIds}
        departments={departments}
      />

      {/* Kanban board */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex gap-4 overflow-x-auto pb-4">
          {columns.map((col) => (
            <TaskColumn
              key={col.id}
              id={col.id}
              label={col.label}
              tasks={col.tasks}
              collapsed={col.id === "DONE" ? collapsedDone : false}
              onToggleCollapse={
                col.id === "DONE"
                  ? () => setCollapsedDone(!collapsedDone)
                  : undefined
              }
              onTaskClick={setSelectedTask}
            />
          ))}
        </div>

        <DragOverlay>
          {activeTask && <TaskCardOverlay task={activeTask} />}
        </DragOverlay>
      </DndContext>

      {/* Task detail panel */}
      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
        />
      )}

      {/* Create task modal */}
      {showCreateModal && (
        <CreateTaskModal
          onClose={() => setShowCreateModal(false)}
          onSubmit={handleCreateTask}
          agents={agentIds}
          isCreating={isCreating}
        />
      )}
    </div>
  );
}

export default TaskBoard;
