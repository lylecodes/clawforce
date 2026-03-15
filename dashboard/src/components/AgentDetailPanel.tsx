import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAppStore } from "../store";
import type { OrgAgent } from "../api/types";

type AgentDetailPanelProps = {
  agent: OrgAgent;
  onClose: () => void;
};

export function AgentDetailPanel({ agent, onClose }: AgentDetailPanelProps) {
  const activeDomain = useAppStore((s) => s.activeDomain);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: detail } = useQuery({
    queryKey: ["agent-detail", activeDomain, agent.id],
    queryFn: () => api.getAgent(activeDomain!, agent.id),
    enabled: !!activeDomain,
  });

  const disableMutation = useMutation({
    mutationFn: () => api.disableAgent(activeDomain!, agent.id, "Disabled via dashboard"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org", activeDomain] });
      queryClient.invalidateQueries({ queryKey: ["agents", activeDomain] });
    },
  });

  const enableMutation = useMutation({
    mutationFn: () => api.enableAgent(activeDomain!, agent.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org", activeDomain] });
      queryClient.invalidateQueries({ queryKey: ["agents", activeDomain] });
    },
  });

  const isDisabled = detail?.status === "disabled";

  return (
    <div className="fixed inset-y-0 right-0 w-[400px] max-w-full bg-cf-bg-secondary border-l border-cf-border shadow-2xl z-50 flex flex-col animate-slide-in">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-cf-border-muted">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-8 h-8 rounded-full bg-cf-bg-tertiary border border-cf-border flex items-center justify-center text-sm font-bold text-cf-text-secondary shrink-0">
            {agent.id.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-cf-text-primary truncate">
              {agent.id}
            </h2>
            <p className="text-xxs text-cf-text-muted truncate">
              {agent.title ?? agent.extends ?? "Agent"}
              {agent.department && ` -- ${agent.department}`}
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-cf-text-muted hover:text-cf-text-primary transition-colors p-1"
          aria-label="Close panel"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M6 6L14 14M14 6L6 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-3">
          <StatBox
            label="Total Cost"
            value={detail ? "$--" : "--"}
          />
          <StatBox
            label="Trust Score"
            value={detail ? "--%" : "--"}
          />
          <StatBox
            label="Tasks Done"
            value={detail?.currentSession ? String(detail.currentSession.toolCalls) : "0"}
          />
          <StatBox
            label="Compliance"
            value="--%"
          />
        </div>

        {/* Current task */}
        <div className="bg-cf-bg-tertiary rounded-lg p-3">
          <h3 className="text-xxs text-cf-text-muted uppercase tracking-wider mb-2">
            Current Task
          </h3>
          {detail?.currentSession ? (
            <div>
              <p className="text-xs text-cf-text-primary">
                Session: {detail.currentSession.key}
              </p>
              <p className="text-xxs text-cf-text-secondary mt-1">
                Started{" "}
                {new Date(detail.currentSession.startedAt).toLocaleString()}
              </p>
              <p className="text-xxs text-cf-text-muted mt-0.5">
                {detail.currentSession.toolCalls} tool calls
              </p>
            </div>
          ) : (
            <p className="text-xs text-cf-text-muted">No active session</p>
          )}
        </div>

        {/* Reports to */}
        {agent.reportsTo && (
          <div className="bg-cf-bg-tertiary rounded-lg p-3">
            <h3 className="text-xxs text-cf-text-muted uppercase tracking-wider mb-1">
              Reports To
            </h3>
            <p className="text-xs text-cf-text-primary">{agent.reportsTo}</p>
          </div>
        )}

        {/* Direct reports */}
        {agent.directReports.length > 0 && (
          <div className="bg-cf-bg-tertiary rounded-lg p-3">
            <h3 className="text-xxs text-cf-text-muted uppercase tracking-wider mb-2">
              Direct Reports ({agent.directReports.length})
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {agent.directReports.map((r) => (
                <span
                  key={r}
                  className="text-xxs bg-cf-bg-secondary px-2 py-0.5 rounded text-cf-text-secondary border border-cf-border"
                >
                  {r}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Expectations */}
        {detail?.expectations && detail.expectations.length > 0 && (
          <div className="bg-cf-bg-tertiary rounded-lg p-3">
            <h3 className="text-xxs text-cf-text-muted uppercase tracking-wider mb-2">
              Expectations
            </h3>
            <ul className="space-y-1">
              {detail.expectations.map((exp, i) => {
                // Defensive: exp may be an Expectation object {tool, action, min_calls}
                // from the backend instead of a plain string
                const label =
                  typeof exp === "string"
                    ? exp
                    : typeof exp === "object" && exp !== null
                      ? (exp as Record<string, unknown>).tool
                        ? `${(exp as Record<string, unknown>).tool}${(exp as Record<string, unknown>).action ? `: ${(exp as Record<string, unknown>).action}` : ""}`
                        : JSON.stringify(exp)
                      : String(exp);
                return (
                  <li key={i} className="text-xxs text-cf-text-secondary flex gap-1.5">
                    <span className="text-cf-accent-blue shrink-0">-</span>
                    {label}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Disabled reason */}
        {detail?.disabledReason && (
          <div className="bg-cf-accent-red/10 border border-cf-accent-red/20 rounded-lg p-3">
            <h3 className="text-xxs text-cf-accent-red uppercase tracking-wider mb-1">
              Disabled
            </h3>
            <p className="text-xs text-cf-text-secondary">
              {detail.disabledReason}
            </p>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="border-t border-cf-border-muted p-4 space-y-2">
        <div className="grid grid-cols-3 gap-2">
          <button
            className="text-xxs px-2 py-1.5 rounded bg-cf-accent-blue/15 text-cf-accent-blue hover:bg-cf-accent-blue/25 transition-colors font-medium"
            onClick={() => navigate("/comms")}
          >
            Message
          </button>
          <button
            className="text-xxs px-2 py-1.5 rounded bg-cf-accent-purple/15 text-cf-accent-purple hover:bg-cf-accent-purple/25 transition-colors font-medium"
            onClick={() => navigate("/tasks")}
          >
            Reassign
          </button>
          {isDisabled ? (
            <button
              className="text-xxs px-2 py-1.5 rounded bg-cf-accent-green/15 text-cf-accent-green hover:bg-cf-accent-green/25 transition-colors font-medium"
              onClick={() => enableMutation.mutate()}
              disabled={enableMutation.isPending}
            >
              {enableMutation.isPending ? "..." : "Enable"}
            </button>
          ) : (
            <button
              className="text-xxs px-2 py-1.5 rounded bg-cf-accent-red/15 text-cf-accent-red hover:bg-cf-accent-red/25 transition-colors font-medium"
              onClick={() => disableMutation.mutate()}
              disabled={disableMutation.isPending}
            >
              {disableMutation.isPending ? "..." : "Disable"}
            </button>
          )}
        </div>
        <button
          className="w-full text-xxs px-2 py-1.5 rounded bg-cf-bg-tertiary text-cf-text-secondary hover:text-cf-text-primary hover:bg-cf-bg-hover transition-colors"
          onClick={() => navigate("/config")}
        >
          Edit Config
        </button>
      </div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-cf-bg-tertiary rounded-lg p-3 text-center">
      <p className="text-xxs text-cf-text-muted uppercase tracking-wider mb-1">
        {label}
      </p>
      <p className="text-lg font-bold text-cf-text-primary">{value}</p>
    </div>
  );
}
