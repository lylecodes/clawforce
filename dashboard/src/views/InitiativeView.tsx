import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { useAppStore } from "../store";
import { api } from "../api/client";
import { ActivityFeed } from "../components/ActivityFeed";
import type { Task, Agent, DailyCost } from "../api/types";
import { theme } from "../styles/theme";

export function InitiativeView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const activeDomain = useAppStore((s) => s.activeDomain);

  const { data: taskData, isLoading: tasksLoading } = useQuery({
    queryKey: ["tasks", activeDomain, { initiative: id }],
    queryFn: () =>
      api.getTasks(activeDomain!, {
        initiative: id!,
        state: "OPEN,ASSIGNED,IN_PROGRESS,REVIEW,BLOCKED,DONE",
      }),
    enabled: !!activeDomain && !!id,
    refetchInterval: 30_000,
  });

  const { data: agents } = useQuery({
    queryKey: ["agents", activeDomain],
    queryFn: () => api.getAgents(activeDomain!),
    enabled: !!activeDomain,
    staleTime: 60_000,
  });

  const { data: costData } = useQuery({
    queryKey: ["costs", activeDomain, "30"],
    queryFn: () => api.getCosts(activeDomain!, { days: "30" }),
    enabled: !!activeDomain,
    staleTime: 60_000,
  });

  if (!activeDomain) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <p className="text-cf-text-muted text-sm">No domain selected</p>
      </div>
    );
  }

  if (!id) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <p className="text-cf-text-muted text-sm">No initiative specified</p>
      </div>
    );
  }

  const tasks: Task[] = taskData?.tasks ?? [];
  const agentList: Agent[] = agents ?? [];
  const dailyCosts: DailyCost[] = costData?.daily ?? [];

  // Task stats
  const openTasks = tasks.filter(
    (t) => t.state === "OPEN" || t.state === "ASSIGNED",
  ).length;
  const inProgressTasks = tasks.filter((t) => t.state === "IN_PROGRESS").length;
  const doneTasks = tasks.filter((t) => t.state === "DONE").length;
  const blockedTasks = tasks.filter((t) => t.state === "BLOCKED").length;

  // Agents working on this initiative
  const assignedAgentIds = new Set(
    tasks.map((t) => t.assignedTo).filter(Boolean),
  );
  const workingAgents = agentList.filter((a) => assignedAgentIds.has(a.id));

  // Cost data for this initiative
  const initiativeCosts = dailyCosts.map((d) => ({
    date: d.date,
    cost: (d.byInitiative[id] ?? 0) / 100,
  }));

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/")}
            className="text-xxs text-cf-text-muted hover:text-cf-accent-blue transition-colors"
          >
            &larr; Back
          </button>
          <h1 className="text-lg font-semibold text-cf-text-primary">{id}</h1>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard label="Open" value={openTasks} color="text-cf-accent-blue" />
        <StatCard
          label="In Progress"
          value={inProgressTasks}
          color="text-cf-accent-orange"
        />
        <StatCard label="Blocked" value={blockedTasks} color="text-cf-accent-red" />
        <StatCard label="Done" value={doneTasks} color="text-cf-accent-green" />
        <StatCard
          label="Agents"
          value={workingAgents.length}
          color="text-cf-accent-purple"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Cost burn chart */}
        <div className="lg:col-span-2 bg-cf-bg-secondary border border-cf-border rounded-lg p-4">
          <h3 className="text-sm font-semibold text-cf-text-primary mb-3">
            Budget Burn Rate
          </h3>
          {initiativeCosts.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={initiativeCosts}>
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: theme.colors.text.muted }}
                  axisLine={{ stroke: theme.colors.border.default }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: theme.colors.text.muted }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `$${v}`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: theme.colors.bg.secondary,
                    border: `1px solid ${theme.colors.border.default}`,
                    borderRadius: 6,
                    fontSize: 11,
                  }}
                  labelStyle={{ color: theme.colors.text.primary }}
                  itemStyle={{ color: theme.colors.accent.blue }}
                  formatter={(value: number) => [`$${value.toFixed(2)}`, "Cost"]}
                />
                <Area
                  type="monotone"
                  dataKey="cost"
                  stroke={theme.colors.accent.blue}
                  fill={theme.colors.accent.blue}
                  fillOpacity={0.15}
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[200px]">
              <p className="text-cf-text-muted text-xs">No cost data available</p>
            </div>
          )}
        </div>

        {/* Working agents */}
        <div className="bg-cf-bg-secondary border border-cf-border rounded-lg p-4">
          <h3 className="text-sm font-semibold text-cf-text-primary mb-3">
            Assigned Agents
          </h3>
          {workingAgents.length > 0 ? (
            <div className="space-y-2">
              {workingAgents.map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center gap-2 bg-cf-bg-tertiary rounded px-3 py-2"
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      agent.status === "active"
                        ? "bg-cf-status-active"
                        : "bg-cf-status-idle"
                    }`}
                  />
                  <span className="text-xs text-cf-text-primary font-medium flex-1">
                    {agent.id}
                  </span>
                  {agent.title && (
                    <span className="text-xxs text-cf-text-muted">{agent.title}</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-cf-text-muted text-xs">No agents assigned</p>
          )}
        </div>
      </div>

      {/* Tasks list + Activity feed */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Task list */}
        <div className="lg:col-span-2 bg-cf-bg-secondary border border-cf-border rounded-lg">
          <div className="px-4 py-3 border-b border-cf-border-muted">
            <h3 className="text-sm font-semibold text-cf-text-primary">
              Tasks ({tasks.length})
            </h3>
          </div>
          <div className="divide-y divide-cf-border-muted max-h-[400px] overflow-y-auto">
            {tasksLoading ? (
              <div className="p-4">
                <p className="text-cf-text-muted text-xs">Loading tasks...</p>
              </div>
            ) : tasks.length === 0 ? (
              <div className="p-4">
                <p className="text-cf-text-muted text-xs">
                  No tasks for this initiative
                </p>
              </div>
            ) : (
              tasks.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))
            )}
          </div>
        </div>

        {/* Activity feed */}
        <div>
          <ActivityFeed />
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="bg-cf-bg-secondary border border-cf-border rounded-lg p-3">
      <p className="text-xxs text-cf-text-muted uppercase tracking-wider mb-1">
        {label}
      </p>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

const STATE_STYLES: Record<string, string> = {
  OPEN: "bg-cf-accent-blue/15 text-cf-accent-blue",
  ASSIGNED: "bg-cf-accent-blue/15 text-cf-accent-blue",
  IN_PROGRESS: "bg-cf-accent-orange/15 text-cf-accent-orange",
  REVIEW: "bg-cf-accent-purple/15 text-cf-accent-purple",
  BLOCKED: "bg-cf-accent-red/15 text-cf-accent-red",
  DONE: "bg-cf-accent-green/15 text-cf-accent-green",
  CANCELLED: "bg-cf-bg-tertiary text-cf-text-muted",
};

function TaskRow({ task }: { task: Task }) {
  const stateStyle = STATE_STYLES[task.state] ?? STATE_STYLES.OPEN;

  return (
    <div className="px-4 py-2.5 flex items-center gap-3 hover:bg-cf-bg-tertiary/50 transition-colors">
      <span
        className={`text-xxs px-1.5 py-0.5 rounded font-bold shrink-0 ${stateStyle}`}
      >
        {task.state}
      </span>
      <span className="text-xs text-cf-text-primary flex-1 truncate">
        {task.title}
      </span>
      {task.assignedTo && (
        <span className="text-xxs text-cf-text-muted truncate max-w-[100px]">
          {task.assignedTo}
        </span>
      )}
      <span className="text-xxs text-cf-text-muted font-mono shrink-0">
        {task.priority}
      </span>
    </div>
  );
}
