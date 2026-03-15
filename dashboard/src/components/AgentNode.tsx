import type { OrgAgent } from "../api/types";

type AgentNodeProps = {
  agent: OrgAgent;
  status?: "active" | "idle" | "disabled" | "warning";
  trustScore?: number;
  spendCents?: number;
  isSelected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
};

const STATUS_DOT: Record<string, string> = {
  active: "bg-cf-status-active",
  idle: "bg-cf-status-idle",
  warning: "bg-cf-status-warning",
  disabled: "bg-cf-status-disabled",
};

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  idle: "Idle",
  warning: "Warning / Retry",
  disabled: "Disabled",
};

function trustColor(score: number): string {
  if (score >= 80) return "bg-cf-accent-green";
  if (score >= 50) return "bg-cf-accent-orange";
  return "bg-cf-accent-red";
}

export function AgentNode({
  agent,
  status = "idle",
  trustScore = 0,
  spendCents = 0,
  isSelected = false,
  onClick,
  onDoubleClick,
}: AgentNodeProps) {
  const isManager = agent.extends === "manager";
  const borderColor = isManager
    ? "border-l-cf-accent-blue"
    : "border-l-cf-accent-green";
  const roleBadgeCls = isManager
    ? "bg-cf-accent-blue/15 text-cf-accent-blue"
    : "bg-cf-accent-green/15 text-cf-accent-green";
  const disabledCls = status === "disabled" ? "opacity-50" : "";
  const selectedCls = isSelected
    ? "ring-2 ring-cf-accent-blue ring-offset-1 ring-offset-cf-bg-primary"
    : "";

  return (
    <div
      className={`
        bg-cf-bg-secondary border border-cf-border border-l-4 ${borderColor}
        rounded-lg cursor-pointer hover:bg-cf-bg-hover transition-all
        ${isManager ? "p-4 min-w-[200px]" : "p-3 min-w-[180px]"}
        ${disabledCls} ${selectedCls}
      `}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {/* Header: avatar + name + status */}
      <div className="flex items-center gap-2 mb-2">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[status] ?? STATUS_DOT.idle}`}
          title={STATUS_LABEL[status]}
        />
        <span className="w-7 h-7 rounded-full bg-cf-bg-tertiary border border-cf-border flex items-center justify-center text-xxs font-bold text-cf-text-secondary shrink-0">
          {agent.id.charAt(0).toUpperCase()}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-cf-text-primary truncate">
            {agent.id}
          </p>
          {agent.title && (
            <p className="text-xxs text-cf-text-muted truncate">{agent.title}</p>
          )}
        </div>
      </div>

      {/* Department + role badge */}
      <div className="flex items-center gap-2 mb-2">
        {agent.department && (
          <span className="text-xxs text-cf-text-secondary truncate">
            {agent.department}
            {agent.team && ` / ${agent.team}`}
          </span>
        )}
        <span className={`text-xxs px-1.5 py-0.5 rounded font-medium ml-auto shrink-0 ${roleBadgeCls}`}>
          {isManager ? "Manager" : "Employee"}
        </span>
      </div>

      {/* Trust score bar */}
      <div className="mb-1.5">
        <div className="flex items-center justify-between mb-0.5">
          <span className="text-xxs text-cf-text-muted">Trust</span>
          <span className="text-xxs text-cf-text-secondary font-mono">{trustScore}%</span>
        </div>
        <div className="h-1 bg-cf-bg-tertiary rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${trustColor(trustScore)}`}
            style={{ width: `${Math.min(trustScore, 100)}%` }}
          />
        </div>
      </div>

      {/* Spend */}
      <div className="flex items-center justify-between">
        <span className="text-xxs text-cf-text-muted">Spend</span>
        <span className="text-xxs text-cf-text-secondary font-mono">
          ${(spendCents / 100).toFixed(2)}
        </span>
      </div>
    </div>
  );
}
