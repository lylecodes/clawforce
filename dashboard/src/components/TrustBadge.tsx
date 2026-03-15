type TrustBadgeProps = {
  /** Approval rate percentage (0-100) */
  approvalRate?: number;
  /** Category of the approval */
  category?: string;
  /** Agent that created the proposal */
  agent?: string;
  /** Callback when "Enable auto-approve" is clicked */
  onEnableAutoApprove?: () => void;
};

const AUTO_APPROVE_THRESHOLD = 90;

export function TrustBadge({
  approvalRate,
  category,
  agent,
  onEnableAutoApprove,
}: TrustBadgeProps) {
  if (approvalRate === undefined) return null;

  const trustColor =
    approvalRate >= 90
      ? "text-cf-accent-green"
      : approvalRate >= 70
        ? "text-cf-accent-orange"
        : "text-cf-accent-red";

  const barColor =
    approvalRate >= 90
      ? "bg-cf-accent-green"
      : approvalRate >= 70
        ? "bg-cf-accent-orange"
        : "bg-cf-accent-red";

  return (
    <div className="bg-cf-bg-tertiary border border-cf-border-muted rounded px-3 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`text-xs font-bold ${trustColor}`}>
          {approvalRate}% trust
        </span>
        {category && (
          <span className="text-xxs text-cf-text-muted">
            for {category}
            {agent ? ` by ${agent}` : ""}
          </span>
        )}
      </div>

      {/* Trust bar */}
      <div className="h-1 bg-cf-bg-primary rounded-full overflow-hidden mb-1.5">
        <div
          className={`h-full ${barColor} rounded-full transition-all duration-500`}
          style={{ width: `${Math.min(approvalRate, 100)}%` }}
        />
      </div>

      {approvalRate >= AUTO_APPROVE_THRESHOLD && onEnableAutoApprove && (
        <div className="flex items-center gap-1.5">
          <span className="text-xxs text-cf-text-muted">
            Consider auto-approving
          </span>
          <button
            onClick={onEnableAutoApprove}
            className="text-xxs text-cf-accent-blue hover:text-cf-accent-blue/80 transition-colors underline"
          >
            Enable
          </button>
        </div>
      )}
    </div>
  );
}
