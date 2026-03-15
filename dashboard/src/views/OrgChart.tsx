import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAppStore } from "../store";
import { OrgTree } from "../components/OrgTree";
import { AgentDetailPanel } from "../components/AgentDetailPanel";
import type { OrgAgent } from "../api/types";

export function OrgChart() {
  const activeDomain = useAppStore((s) => s.activeDomain);
  const navigate = useNavigate();
  const [selectedAgent, setSelectedAgent] = useState<OrgAgent | null>(null);

  const { data: orgData, isLoading: orgLoading } = useQuery({
    queryKey: ["org", activeDomain],
    queryFn: () => api.getOrgChart(activeDomain!),
    enabled: !!activeDomain,
    refetchInterval: 30_000,
  });

  const { data: agents } = useQuery({
    queryKey: ["agents", activeDomain],
    queryFn: () => api.getAgents(activeDomain!),
    enabled: !!activeDomain,
    refetchInterval: 30_000,
  });

  const { data: trustData } = useQuery({
    queryKey: ["trust", activeDomain],
    queryFn: () => api.getTrustScores(activeDomain!),
    enabled: !!activeDomain,
    refetchInterval: 60_000,
  });

  // Build status map from agents list
  const statusMap = useMemo(() => {
    const map: Record<string, "active" | "idle" | "disabled" | "warning"> = {};
    if (agents) {
      for (const a of agents) {
        map[a.id] = a.status as "active" | "idle" | "disabled";
      }
    }
    return map;
  }, [agents]);

  // Build trust map
  const trustMap = useMemo(() => {
    const map: Record<string, number> = {};
    if (trustData?.agents) {
      for (const entry of trustData.agents) {
        const a = entry as { agentId?: string; overall?: number };
        if (a.agentId !== undefined && a.overall !== undefined) {
          map[a.agentId] = a.overall;
        }
      }
    }
    return map;
  }, [trustData]);

  // Spend map placeholder (would be populated from cost data)
  const spendMap = useMemo<Record<string, number>>(() => ({}), []);

  if (!activeDomain) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="text-center">
          <p className="text-cf-text-secondary text-lg mb-2">
            No domain selected
          </p>
          <p className="text-cf-text-muted text-sm">
            Select a domain from the switcher above to view the org chart.
          </p>
        </div>
      </div>
    );
  }

  if (orgLoading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <p className="text-cf-text-muted text-sm">Loading org chart...</p>
      </div>
    );
  }

  const orgAgents = orgData?.agents ?? [];
  const departments = orgData?.departments ?? [];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-cf-text-primary">
            Org Chart
          </h1>
          <p className="text-xxs text-cf-text-muted">
            {orgAgents.length} agent{orgAgents.length !== 1 ? "s" : ""}
            {departments.length > 0 && ` across ${departments.length} department${departments.length !== 1 ? "s" : ""}`}
          </p>
        </div>

        {/* Department filter badges */}
        {departments.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            {departments.map((dept) => (
              <span
                key={dept}
                className="text-xxs px-2 py-0.5 rounded bg-cf-bg-tertiary text-cf-text-secondary border border-cf-border"
              >
                {dept}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Tree */}
      <div className="bg-cf-bg-secondary border border-cf-border rounded-lg p-6 min-h-[500px]">
        <OrgTree
          agents={orgAgents}
          statusMap={statusMap}
          trustMap={trustMap}
          spendMap={spendMap}
          selectedAgentId={selectedAgent?.id ?? null}
          onSelectAgent={setSelectedAgent}
          onDoubleClickAgent={() => navigate("/config")}
        />
      </div>

      {/* Detail panel (slides in from right) */}
      {selectedAgent && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/30 z-40"
            onClick={() => setSelectedAgent(null)}
          />
          <AgentDetailPanel
            agent={selectedAgent}
            onClose={() => setSelectedAgent(null)}
          />
        </>
      )}
    </div>
  );
}
