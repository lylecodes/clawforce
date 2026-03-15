import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAppStore } from "../store";
import {
  TimeRangeSelector,
  timeRangeToDays,
  type TimeRange,
} from "../components/TimeRangeSelector";
import { CostChart } from "../components/CostChart";
import { InitiativeDonut } from "../components/InitiativeDonut";
import { PerformanceTable } from "../components/PerformanceTable";
import { TrustBars } from "../components/TrustBars";
import type { AgentTrustScore } from "../api/types";

export function Analytics() {
  const activeDomain = useAppStore((s) => s.activeDomain);
  const [timeRange, setTimeRange] = useState<TimeRange>("7d");

  const days = timeRangeToDays(timeRange);

  const { data: costData, isLoading: costsLoading } = useQuery({
    queryKey: ["costs", activeDomain, days],
    queryFn: () =>
      api.getCosts(activeDomain!, { days: String(days) }),
    enabled: !!activeDomain,
    refetchInterval: 60_000,
  });

  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: ["agents", activeDomain],
    queryFn: () => api.getAgents(activeDomain!),
    enabled: !!activeDomain,
    refetchInterval: 30_000,
  });

  const { data: trustData, isLoading: trustLoading } = useQuery({
    queryKey: ["trust", activeDomain],
    queryFn: () => api.getTrustScores(activeDomain!),
    enabled: !!activeDomain,
    refetchInterval: 60_000,
  });

  if (!activeDomain) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="text-center">
          <p className="text-cf-text-secondary text-lg mb-2">
            No domain selected
          </p>
          <p className="text-cf-text-muted text-sm">
            Select a domain from the switcher above to view analytics.
          </p>
        </div>
      </div>
    );
  }

  const isLoading = costsLoading || agentsLoading || trustLoading;
  const dailyCosts = costData?.daily ?? [];
  const agentList = agents ?? [];
  const trustAgents: AgentTrustScore[] = (trustData?.agents ?? []) as AgentTrustScore[];

  return (
    <div className="space-y-4">
      {/* Header + time range selector */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-semibold text-cf-text-primary">
            Analytics
          </h1>
          <p className="text-xxs text-cf-text-muted">
            Cost trends, agent performance, and trust evolution
          </p>
        </div>
        <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <p className="text-cf-text-muted text-sm">Loading analytics...</p>
        </div>
      )}

      {/* 4-panel grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 1. Daily cost bar chart */}
        <CostChart data={dailyCosts} />

        {/* 2. Cost by initiative donut */}
        <InitiativeDonut data={dailyCosts} />

        {/* 3. Agent performance table */}
        <PerformanceTable agents={agentList} />

        {/* 4. Trust score bars */}
        <TrustBars agents={trustAgents} />
      </div>

      {/* Summary stats row */}
      {costData && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <SummaryCard
            label="Total Spend"
            value={`$${((costData.totalCents ?? 0) / 100).toFixed(2)}`}
            subtitle={`Last ${days} day${days !== 1 ? "s" : ""}`}
          />
          <SummaryCard
            label="Avg Daily"
            value={
              dailyCosts.length > 0 && costData.totalCents != null
                ? `$${(costData.totalCents / 100 / dailyCosts.length).toFixed(2)}`
                : "$0.00"
            }
            subtitle="Per day"
          />
          <SummaryCard
            label="Active Agents"
            value={String(agentList.filter((a) => a.status === "active").length)}
            subtitle={`${agentList.length} total`}
          />
          <SummaryCard
            label="Avg Trust"
            value={
              trustAgents.length > 0
                ? `${Math.round(trustAgents.reduce((s, a) => s + a.overall, 0) / trustAgents.length)}%`
                : "N/A"
            }
            subtitle={trustAgents.length > 0 ? `${trustAgents.length} scored` : "No data"}
          />
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  subtitle,
}: {
  label: string;
  value: string;
  subtitle: string;
}) {
  return (
    <div className="bg-cf-bg-secondary border border-cf-border rounded-lg p-4">
      <p className="text-xxs text-cf-text-muted uppercase tracking-wider mb-1">
        {label}
      </p>
      <p className="text-xl font-bold text-cf-text-primary">{value}</p>
      <p className="text-xxs text-cf-text-muted mt-1">{subtitle}</p>
    </div>
  );
}

export default Analytics;
