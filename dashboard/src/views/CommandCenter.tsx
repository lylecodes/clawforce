import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "../store";
import { api } from "../api/client";
import { MetricCard } from "../components/MetricCard";
import { InitiativeCard } from "../components/InitiativeCard";
import { ActivityFeed } from "../components/ActivityFeed";
import { AgentRoster } from "../components/AgentRoster";
import type { DashboardSummary, Agent } from "../api/types";

function budgetVariant(pct: number): "success" | "warning" | "danger" {
  if (pct > 90) return "danger";
  if (pct > 70) return "warning";
  return "success";
}

function approvalVariant(count: number): "default" | "warning" | "danger" {
  if (count > 10) return "danger";
  if (count > 3) return "warning";
  return "default";
}

export function CommandCenter() {
  const activeDomain = useAppStore((s) => s.activeDomain);

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["dashboard", activeDomain],
    queryFn: () => api.getDashboard(activeDomain!),
    enabled: !!activeDomain,
    refetchInterval: 30_000,
  });

  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: ["agents", activeDomain],
    queryFn: () => api.getAgents(activeDomain!),
    enabled: !!activeDomain,
    refetchInterval: 30_000,
  });

  if (!activeDomain) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="text-center">
          <p className="text-cf-text-secondary text-lg mb-2">
            No domain selected
          </p>
          <p className="text-cf-text-muted text-sm">
            Select a domain from the switcher above to view the command center.
          </p>
        </div>
      </div>
    );
  }

  const dash: DashboardSummary = summary ?? {
    budgetUtilization: { spent: 0, limit: 0, pct: 0 },
    activeAgents: 0,
    totalAgents: 0,
    tasksInFlight: 0,
    pendingApprovals: 0,
  };

  const agentList: Agent[] = agents ?? [];

  return (
    <div className="space-y-6">
      {/* Metric Cards Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Budget Utilization"
          value={`${dash.budgetUtilization.pct}%`}
          subtitle={
            summaryLoading
              ? "Loading..."
              : `$${(dash.budgetUtilization.spent / 100).toFixed(2)} / $${(dash.budgetUtilization.limit / 100).toFixed(2)}`
          }
          progress={dash.budgetUtilization.pct}
          variant={budgetVariant(dash.budgetUtilization.pct)}
        />
        <MetricCard
          label="Active Agents"
          value={summaryLoading ? "--" : dash.activeAgents}
          subtitle={`${dash.totalAgents} total`}
          progress={
            dash.totalAgents > 0
              ? (dash.activeAgents / dash.totalAgents) * 100
              : 0
          }
          variant="success"
        />
        <MetricCard
          label="Tasks in Flight"
          value={summaryLoading ? "--" : dash.tasksInFlight}
          subtitle="Assigned + In Progress"
          variant="default"
        />
        <MetricCard
          label="Pending Approvals"
          value={summaryLoading ? "--" : dash.pendingApprovals}
          subtitle={
            dash.pendingApprovals > 0 ? "Action required" : "All clear"
          }
          variant={approvalVariant(dash.pendingApprovals)}
        />
      </div>

      {/* Initiative Cards Row (placeholder — shows when data available) */}
      <InitiativesSection domain={activeDomain} />

      {/* Bottom: Activity Feed + Agent Roster */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <ActivityFeed />
        </div>
        <div>
          <AgentRoster agents={agentList} isLoading={agentsLoading} />
        </div>
      </div>
    </div>
  );
}

/**
 * Initiatives section — fetches goals to show as initiative cards.
 * Falls back to an empty state when no goals are configured.
 */
function InitiativesSection({ domain }: { domain: string }) {
  const { data } = useQuery({
    queryKey: ["goals", domain, "top-level"],
    queryFn: () =>
      api.getTasks(domain, { state: "OPEN,ASSIGNED,IN_PROGRESS,DONE" }),
    enabled: !!domain,
    staleTime: 30_000,
  });

  // For now, show a placeholder when no initiative data
  // This will be enhanced when we have the goals/initiative grouping endpoint
  if (!data || data.count === 0) {
    return null;
  }

  // Group tasks by department as a proxy for initiatives
  const byDept = new Map<string, { open: number; inProgress: number; done: number }>();
  for (const task of data.tasks) {
    const dept = task.department ?? "Unassigned";
    const entry = byDept.get(dept) ?? { open: 0, inProgress: 0, done: 0 };
    if (task.state === "OPEN" || task.state === "ASSIGNED") entry.open++;
    else if (task.state === "IN_PROGRESS") entry.inProgress++;
    else if (task.state === "DONE") entry.done++;
    byDept.set(dept, entry);
  }

  if (byDept.size === 0) return null;

  const colors = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff"];
  const depts = Array.from(byDept.entries());

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {depts.map(([dept, counts], i) => {
        const total = counts.open + counts.inProgress + counts.done;
        return (
          <InitiativeCard
            key={dept}
            name={dept}
            allocationPct={Math.round((total / data.count) * 100)}
            spentPct={total > 0 ? Math.round((counts.done / total) * 100) : 0}
            taskCounts={counts}
            activeAgents={[]}
            color={colors[i % colors.length]}
          />
        );
      })}
    </div>
  );
}
