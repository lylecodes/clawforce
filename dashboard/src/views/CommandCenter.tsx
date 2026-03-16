import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store";
import { api } from "../api/client";
import { MetricCard } from "../components/MetricCard";
import { InitiativeCard } from "../components/InitiativeCard";
import { ActivityFeed } from "../components/ActivityFeed";
import { AgentRoster } from "../components/AgentRoster";
import { WelcomeScreen } from "../components/WelcomeScreen";
import type { DashboardSummary, Agent, Goal } from "../api/types";

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
  const domains = useAppStore((s) => s.domains);
  const domainsLoaded = useAppStore((s) => s.domainsLoaded);

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

  // While domains are still being fetched, show a loading spinner (not the WelcomeScreen)
  if (!domainsLoaded) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-cf-accent-blue border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-cf-text-muted text-sm">Loading domains...</p>
        </div>
      </div>
    );
  }

  // Show welcome/onboarding screen only when domains query has completed and confirmed empty
  if (domains.length === 0 && !activeDomain) {
    return <WelcomeScreen />;
  }

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
          subtitle="Active tasks"
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
 * Initiatives section — fetches goals and renders one card per goal.
 * Renders nothing while loading or when no goals are configured.
 * Uses task data only for per-department counts within the goal cards.
 */
function InitiativesSection({ domain }: { domain: string }) {
  const navigate = useNavigate();
  const { data: goalsData } = useQuery({
    queryKey: ["goals", domain, "top-level"],
    queryFn: () => api.getGoals(domain, { parent: "none" }),
    enabled: !!domain,
    staleTime: 30_000,
  });

  const { data: tasksData } = useQuery({
    queryKey: ["tasks", domain, "initiative-counts"],
    queryFn: () =>
      api.getTasks(domain, { state: "OPEN,ASSIGNED,IN_PROGRESS,DONE" }),
    enabled: !!domain,
    staleTime: 30_000,
  });

  const colors = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff"];

  // Deduplicate goals by title (guards against duplicate DB entries from repeated demo setup)
  const rawGoals: Goal[] = goalsData?.goals ?? [];
  const seenTitles = new Set<string>();
  const goals = rawGoals.filter((g) => {
    if (seenTitles.has(g.title)) return false;
    seenTitles.add(g.title);
    return true;
  });

  // Render from goals only — don't fall back to task-based department grouping
  // to prevent duplicate cards when both data sources are available.
  if (!goalsData) {
    // Still loading — render nothing to avoid flash of task-based cards
    return null;
  }

  if (goals.length === 0) {
    return null;
  }

  // Count tasks per goal: match by goalId linkage OR by department
  const tasksByGoal = new Map<string, { open: number; inProgress: number; done: number }>();
  if (tasksData) {
    for (const goal of goals) {
      const counts = { open: 0, inProgress: 0, done: 0 };
      for (const task of tasksData.tasks) {
        // Match task to goal via explicit goalId or department
        const linked = task.goalId === goal.id || (goal.department && task.department === goal.department);
        if (!linked) continue;
        if (task.state === "OPEN" || task.state === "ASSIGNED") counts.open++;
        else if (task.state === "IN_PROGRESS") counts.inProgress++;
        else if (task.state === "DONE") counts.done++;
      }
      tasksByGoal.set(goal.id, counts);
    }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {goals.map((goal, i) => {
        const goalCounts = tasksByGoal.get(goal.id) ?? { open: 0, inProgress: 0, done: 0 };
        const total = goalCounts.open + goalCounts.inProgress + goalCounts.done;
        return (
          <InitiativeCard
            key={goal.id}
            name={goal.title}
            allocationPct={goal.allocation ?? 0}
            spentPct={total > 0 ? Math.round((goalCounts.done / total) * 100) : 0}
            taskCounts={goalCounts}
            activeAgents={[]}
            color={colors[i % colors.length]}
            onClick={() => navigate(`/initiatives/${encodeURIComponent(goal.id)}`)}
          />
        );
      })}
    </div>
  );
}

export default CommandCenter;
