import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../store";
import { api } from "../api/client";
import type { Task, TaskState } from "../api/types";

export type TaskFilters = {
  initiative?: string;
  assignee?: string;
  priority?: string;
};

export type KanbanColumn = {
  id: TaskState;
  label: string;
  tasks: Task[];
  collapsed?: boolean;
};

const KANBAN_STATES: { id: TaskState; label: string; collapsed?: boolean }[] = [
  { id: "OPEN", label: "Open" },
  { id: "IN_PROGRESS", label: "In Progress" },
  { id: "REVIEW", label: "Review" },
  { id: "BLOCKED", label: "Blocked" },
  { id: "DONE", label: "Done", collapsed: true },
];

function buildFilterParams(filters: TaskFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters.assignee) params.assignee = filters.assignee;
  if (filters.priority) params.priority = filters.priority;
  if (filters.initiative) params.initiative = filters.initiative;
  // Fetch all kanban-relevant states
  params.state = "OPEN,ASSIGNED,IN_PROGRESS,REVIEW,BLOCKED,DONE";
  return params;
}

function groupByState(tasks: Task[]): KanbanColumn[] {
  return KANBAN_STATES.map((col) => ({
    ...col,
    tasks: tasks
      .filter((t) => {
        if (col.id === "OPEN") return t.state === "OPEN" || t.state === "ASSIGNED";
        return t.state === col.id;
      })
      .sort((a, b) => {
        // Sort by priority first (P0 > P1 > P2 > P3), then by updatedAt
        const pa = parseInt(a.priority.slice(1));
        const pb = parseInt(b.priority.slice(1));
        if (pa !== pb) return pa - pb;
        return b.updatedAt - a.updatedAt;
      }),
  }));
}

export function useTasks(filters: TaskFilters = {}) {
  const activeDomain = useAppStore((s) => s.activeDomain);
  const queryClient = useQueryClient();

  const params = buildFilterParams(filters);

  const { data, isLoading, error } = useQuery({
    queryKey: ["tasks", activeDomain, params],
    queryFn: () => api.getTasks(activeDomain!, params),
    enabled: !!activeDomain,
    refetchInterval: 30_000,
  });

  const columns = groupByState(data?.tasks ?? []);

  const reassignMutation = useMutation({
    mutationFn: ({
      taskId,
      newAssignee,
    }: {
      taskId: string;
      newAssignee: string;
    }) => api.reassignTask(activeDomain!, taskId, newAssignee),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks", activeDomain] });
    },
  });

  const createTaskMutation = useMutation({
    mutationFn: (taskData: Record<string, unknown>) =>
      api.createTask(activeDomain!, taskData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks", activeDomain] });
    },
  });

  return {
    tasks: data?.tasks ?? [],
    columns,
    totalCount: data?.count ?? 0,
    isLoading,
    error,
    reassignTask: reassignMutation.mutate,
    createTask: createTaskMutation.mutate,
    isReassigning: reassignMutation.isPending,
    isCreating: createTaskMutation.isPending,
  };
}
