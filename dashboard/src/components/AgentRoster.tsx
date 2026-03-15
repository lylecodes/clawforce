import type { Agent } from "../api/types";

type AgentRosterProps = {
  agents: Agent[];
  isLoading?: boolean;
};

const STATUS_DOT: Record<string, string> = {
  active: "bg-cf-status-active",
  idle: "bg-cf-status-idle",
  disabled: "bg-cf-status-disabled",
};

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  idle: "Idle",
  disabled: "Disabled",
};

export function AgentRoster({ agents, isLoading }: AgentRosterProps) {
  return (
    <div className="bg-cf-bg-secondary border border-cf-border rounded-lg flex flex-col h-full">
      <div className="px-4 py-3 border-b border-cf-border-muted flex items-center justify-between">
        <h3 className="text-sm font-semibold text-cf-text-primary">
          Agent Roster
        </h3>
        <span className="text-xxs text-cf-text-muted font-mono">
          {agents.filter((a) => a.status === "active").length}/
          {agents.length} active
        </span>
      </div>

      <div className="flex-1 overflow-y-auto max-h-[400px]">
        {isLoading ? (
          <div className="p-4 text-center text-cf-text-muted text-sm">
            Loading agents...
          </div>
        ) : agents.length === 0 ? (
          <div className="p-4 text-center text-cf-text-muted text-sm">
            No agents registered.
          </div>
        ) : (
          <div className="divide-y divide-cf-border-muted">
            {agents.map((agent) => (
              <div
                key={agent.id}
                className="px-4 py-2.5 flex items-center gap-3 hover:bg-cf-bg-tertiary/50 transition-colors"
              >
                {/* Status dot */}
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                    STATUS_DOT[agent.status] ?? STATUS_DOT.idle
                  }`}
                  title={STATUS_LABEL[agent.status]}
                />

                {/* Avatar */}
                <span className="w-7 h-7 rounded-full bg-cf-bg-tertiary border border-cf-border flex items-center justify-center text-xxs font-bold text-cf-text-secondary shrink-0">
                  {agent.id.charAt(0).toUpperCase()}
                </span>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-cf-text-primary font-medium truncate">
                    {agent.id}
                  </p>
                  <p className="text-xxs text-cf-text-muted truncate">
                    {agent.title ?? agent.extends ?? "Agent"}
                    {agent.department && (
                      <span className="ml-1 opacity-70">
                        / {agent.department}
                      </span>
                    )}
                  </p>
                </div>

                {/* Role badge */}
                {agent.extends && (
                  <span
                    className={`text-xxs px-1.5 py-0.5 rounded font-medium ${
                      agent.extends === "manager"
                        ? "bg-cf-accent-blue/15 text-cf-accent-blue"
                        : "bg-cf-accent-green/15 text-cf-accent-green"
                    }`}
                  >
                    {agent.extends === "manager" ? "MGR" : "EMP"}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
