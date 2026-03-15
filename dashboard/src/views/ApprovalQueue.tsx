import { useState, useCallback } from "react";
import { useApprovals, type ApprovalTab } from "../hooks/useApprovals";
import { useAppStore } from "../store";
import { ApprovalRow } from "../components/ApprovalRow";

const TABS: { id: ApprovalTab; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
];

export function ApprovalQueue() {
  const activeDomain = useAppStore((s) => s.activeDomain);
  const [activeTab, setActiveTab] = useState<ApprovalTab>("pending");

  const {
    proposals,
    pendingCount,
    isLoading,
    approve,
    reject,
    approveAllLowRisk,
    isApproving,
    isRejecting,
    isBulkApproving,
  } = useApprovals(activeTab);

  const handleApprove = useCallback(
    (id: string) => approve(id),
    [approve],
  );

  const handleReject = useCallback(
    (id: string, feedback?: string) => reject({ id, feedback }),
    [reject],
  );

  const lowRiskCount =
    activeTab === "pending"
      ? proposals.filter(
          (p) => p.riskTier === "low" && p.status === "pending",
        ).length
      : 0;

  if (!activeDomain) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="text-center">
          <p className="text-cf-text-secondary text-lg mb-2">
            No domain selected
          </p>
          <p className="text-cf-text-muted text-sm">
            Select a domain from the switcher above to view the approval queue.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header row: tabs + bulk action */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        {/* Tabs */}
        <div className="flex items-center gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`text-xs font-medium px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
                activeTab === tab.id
                  ? "bg-cf-bg-tertiary text-cf-text-primary"
                  : "text-cf-text-secondary hover:text-cf-text-primary hover:bg-cf-bg-tertiary/50"
              }`}
            >
              {tab.label}
              {tab.id === "pending" && pendingCount > 0 && (
                <span className="text-xxs font-mono bg-cf-accent-orange/15 text-cf-accent-orange px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                  {pendingCount}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Bulk approve button */}
        {activeTab === "pending" && lowRiskCount > 0 && (
          <button
            onClick={() => approveAllLowRisk()}
            disabled={isBulkApproving}
            className="text-xs font-medium px-3 py-1.5 rounded bg-cf-accent-green/15 text-cf-accent-green border border-cf-accent-green/30 hover:bg-cf-accent-green/25 transition-colors disabled:opacity-50"
          >
            {isBulkApproving
              ? "Approving..."
              : `Approve All Low Risk (${lowRiskCount})`}
          </button>
        )}
      </div>

      {/* Approval list */}
      <div className="bg-cf-bg-secondary border border-cf-border rounded-lg">
        {isLoading ? (
          <div className="p-6">
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="h-10 bg-cf-bg-tertiary rounded animate-pulse"
                />
              ))}
            </div>
          </div>
        ) : proposals.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-cf-text-muted text-sm">
              {activeTab === "pending"
                ? "No pending approvals. All clear!"
                : activeTab === "approved"
                  ? "No approved items yet."
                  : "No rejected items yet."}
            </p>
          </div>
        ) : (
          <div>
            {/* Column headers */}
            <div className="px-4 py-2 border-b border-cf-border-muted flex items-center gap-3 text-xxs text-cf-text-muted uppercase tracking-wider font-semibold">
              <span className="w-3" /> {/* chevron space */}
              <span className="w-[52px]">Risk</span>
              <span className="flex-1">Title</span>
              <span className="w-[90px] hidden sm:block">Agent</span>
              <span className="w-[80px] hidden md:block">Category</span>
              <span className="w-[55px] text-right">Time</span>
              <span className="w-[56px]">
                {activeTab === "pending" ? "Actions" : "Status"}
              </span>
            </div>

            {/* Rows */}
            {proposals.map((proposal) => (
              <ApprovalRow
                key={proposal.id}
                proposal={proposal}
                onApprove={handleApprove}
                onReject={handleReject}
                isApproving={isApproving}
                isRejecting={isRejecting}
              />
            ))}
          </div>
        )}
      </div>

      {/* Summary footer */}
      {proposals.length > 0 && (
        <div className="text-xxs text-cf-text-muted text-right">
          Showing {proposals.length} {activeTab} approval
          {proposals.length !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}

export default ApprovalQueue;
