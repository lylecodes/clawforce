import { useState } from "react";
import type { Proposal } from "../api/types";
import { getRiskColor, formatRelativeTime } from "../hooks/useApprovals";
import { TrustBadge } from "./TrustBadge";

type ApprovalRowProps = {
  proposal: Proposal;
  onApprove: (id: string) => void;
  onReject: (id: string, feedback?: string) => void;
  isApproving?: boolean;
  isRejecting?: boolean;
};

export function ApprovalRow({
  proposal,
  onApprove,
  onReject,
  isApproving,
  isRejecting,
}: ApprovalRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState("");

  const riskClass = getRiskColor(proposal.riskTier);
  const isPending = proposal.status === "pending";

  return (
    <div
      className={`border-b border-cf-border-muted last:border-b-0 transition-colors ${
        expanded ? "bg-cf-bg-tertiary/30" : "hover:bg-cf-bg-tertiary/20"
      }`}
    >
      {/* Collapsed row */}
      <div
        className="px-4 py-3 flex items-center gap-3 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Expand indicator */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={`text-cf-text-muted shrink-0 transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
        >
          <path d="M4 2l4 4-4 4" />
        </svg>

        {/* Risk badge */}
        <span
          className={`text-xxs px-1.5 py-0.5 rounded border font-semibold uppercase shrink-0 ${riskClass}`}
        >
          {proposal.riskTier ?? "—"}
        </span>

        {/* Title */}
        <span className="text-xs text-cf-text-primary flex-1 truncate font-medium">
          {proposal.title}
        </span>

        {/* Agent */}
        <span className="text-xxs text-cf-text-secondary shrink-0 flex items-center gap-1">
          <span className="w-4 h-4 rounded-full bg-cf-bg-tertiary border border-cf-border flex items-center justify-center text-[9px] font-bold text-cf-text-secondary">
            {proposal.agentId.charAt(0).toUpperCase()}
          </span>
          <span className="hidden sm:inline truncate max-w-[80px]">
            {proposal.agentId}
          </span>
        </span>

        {/* Category */}
        {proposal.category && (
          <span className="text-xxs text-cf-text-muted shrink-0 hidden md:inline">
            {proposal.category}
          </span>
        )}

        {/* Time */}
        <span className="text-xxs text-cf-text-muted font-mono shrink-0 w-[55px] text-right">
          {formatRelativeTime(proposal.createdAt)}
        </span>

        {/* Inline action buttons (pending only) */}
        {isPending && (
          <div className="flex items-center gap-1 shrink-0 ml-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onApprove(proposal.id);
              }}
              disabled={isApproving}
              className="w-6 h-6 rounded flex items-center justify-center text-cf-accent-green hover:bg-cf-accent-green/15 transition-colors disabled:opacity-50"
              title="Approve"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M3 7l3 3 5-6" />
              </svg>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onReject(proposal.id);
              }}
              disabled={isRejecting}
              className="w-6 h-6 rounded flex items-center justify-center text-cf-accent-red hover:bg-cf-accent-red/15 transition-colors disabled:opacity-50"
              title="Reject"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M4 4l6 6M10 4l-6 6" />
              </svg>
            </button>
          </div>
        )}

        {/* Status badge for resolved */}
        {!isPending && (
          <span
            className={`text-xxs px-1.5 py-0.5 rounded font-medium shrink-0 ${
              proposal.status === "approved"
                ? "bg-cf-accent-green/15 text-cf-accent-green"
                : "bg-cf-accent-red/15 text-cf-accent-red"
            }`}
          >
            {proposal.status === "approved" ? "Approved" : "Rejected"}
          </span>
        )}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 pl-10 space-y-3">
          {/* Description */}
          {proposal.description && (
            <div>
              <h4 className="text-xxs text-cf-text-muted uppercase tracking-wider font-semibold mb-1">
                Context
              </h4>
              <p className="text-xs text-cf-text-secondary leading-relaxed whitespace-pre-wrap">
                {proposal.description}
              </p>
            </div>
          )}

          {/* Meta grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {proposal.toolName && (
              <div>
                <dt className="text-xxs text-cf-text-muted mb-0.5">Tool</dt>
                <dd className="text-xs text-cf-text-primary font-mono">
                  {proposal.toolName}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-xxs text-cf-text-muted mb-0.5">Category</dt>
              <dd className="text-xs text-cf-text-primary">
                {proposal.category ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xxs text-cf-text-muted mb-0.5">Agent</dt>
              <dd className="text-xs text-cf-text-primary">
                {proposal.agentId}
              </dd>
            </div>
            <div>
              <dt className="text-xxs text-cf-text-muted mb-0.5">Created</dt>
              <dd className="text-xs text-cf-text-primary font-mono">
                {new Date(proposal.createdAt).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </dd>
            </div>
          </div>

          {/* Trust context */}
          <TrustBadge
            approvalRate={92}
            category={proposal.category}
            agent={proposal.agentId}
          />

          {/* Feedback + action buttons for pending */}
          {isPending && (
            <div className="flex items-end gap-3 pt-1">
              <div className="flex-1">
                <label className="text-xxs text-cf-text-muted mb-1 block">
                  Feedback (optional)
                </label>
                <input
                  type="text"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="Add feedback..."
                  className="w-full text-xs bg-cf-bg-primary border border-cf-border rounded px-2.5 py-1.5 text-cf-text-primary placeholder:text-cf-text-muted focus:border-cf-accent-blue focus:outline-none"
                />
              </div>
              <button
                onClick={() => onApprove(proposal.id)}
                disabled={isApproving}
                className="text-xs font-medium px-4 py-1.5 rounded bg-cf-accent-green/15 text-cf-accent-green border border-cf-accent-green/30 hover:bg-cf-accent-green/25 transition-colors disabled:opacity-50"
              >
                Approve
              </button>
              <button
                onClick={() =>
                  onReject(proposal.id, feedback || undefined)
                }
                disabled={isRejecting}
                className="text-xs font-medium px-4 py-1.5 rounded bg-cf-accent-red/15 text-cf-accent-red border border-cf-accent-red/30 hover:bg-cf-accent-red/25 transition-colors disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          )}

          {/* Feedback display for resolved */}
          {!isPending && proposal.feedback && (
            <div>
              <h4 className="text-xxs text-cf-text-muted uppercase tracking-wider font-semibold mb-1">
                Feedback
              </h4>
              <p className="text-xs text-cf-text-secondary italic">
                "{proposal.feedback}"
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
