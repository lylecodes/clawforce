type InitiativeCardProps = {
  name: string;
  allocationPct: number;
  spentPct: number;
  taskCounts: {
    open: number;
    inProgress: number;
    done: number;
  };
  activeAgents: string[];
  color?: string;
  onClick?: () => void;
};

export function InitiativeCard({
  name,
  allocationPct,
  spentPct,
  taskCounts,
  activeAgents,
  color = "#58a6ff",
  onClick,
}: InitiativeCardProps) {
  const utilizationVariant =
    spentPct > 90 ? "bg-cf-accent-red" : spentPct > 70 ? "bg-cf-accent-orange" : "bg-cf-accent-green";

  return (
    <button
      onClick={onClick}
      className="bg-cf-bg-secondary border border-cf-border rounded-lg p-4 text-left w-full hover:border-cf-text-muted transition-colors group"
    >
      {/* Color bar top */}
      <div className="h-1 rounded-full mb-3" style={{ backgroundColor: color }} />

      <div className="flex items-start justify-between mb-3">
        <h3 className="text-sm font-semibold text-cf-text-primary group-hover:text-cf-accent-blue transition-colors">
          {name}
        </h3>
        <span className="text-xxs text-cf-text-muted font-mono">
          {allocationPct}% alloc
        </span>
      </div>

      {/* Spend progress bar */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xxs text-cf-text-secondary">Budget used</span>
          <span className="text-xxs text-cf-text-muted">{spentPct}%</span>
        </div>
        <div className="h-1.5 bg-cf-bg-tertiary rounded-full overflow-hidden">
          <div
            className={`h-full ${utilizationVariant} rounded-full transition-all duration-500`}
            style={{ width: `${Math.min(spentPct, 100)}%` }}
          />
        </div>
      </div>

      {/* Task counts */}
      <div className="flex items-center gap-3 mb-3">
        <TaskCount label="Open" count={taskCounts.open} color="text-cf-accent-blue" />
        <TaskCount label="In Progress" count={taskCounts.inProgress} color="text-cf-accent-orange" />
        <TaskCount label="Done" count={taskCounts.done} color="text-cf-accent-green" />
      </div>

      {/* Active agents */}
      {activeAgents.length > 0 && (
        <div className="flex items-center gap-1">
          {activeAgents.slice(0, 4).map((agent) => (
            <span
              key={agent}
              className="w-6 h-6 rounded-full bg-cf-bg-tertiary border border-cf-border flex items-center justify-center text-xxs text-cf-text-secondary"
              title={agent}
            >
              {agent.charAt(0).toUpperCase()}
            </span>
          ))}
          {activeAgents.length > 4 && (
            <span className="text-xxs text-cf-text-muted ml-1">
              +{activeAgents.length - 4}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

function TaskCount({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className={`text-sm font-bold ${color}`}>{count}</span>
      <span className="text-xxs text-cf-text-muted">{label}</span>
    </div>
  );
}
