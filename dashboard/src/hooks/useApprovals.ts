import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../store";
import { api } from "../api/client";

export type ApprovalTab = "pending" | "approved" | "rejected";

export function useApprovals(tab: ApprovalTab = "pending") {
  const activeDomain = useAppStore((s) => s.activeDomain);
  const queryClient = useQueryClient();

  const params: Record<string, string> = { status: tab };

  const { data, isLoading, error } = useQuery({
    queryKey: ["approvals", activeDomain, tab],
    queryFn: () => api.getApprovals(activeDomain!, params),
    enabled: !!activeDomain,
    refetchInterval: 15_000,
  });

  // Also fetch pending count for the tab badge (always)
  const { data: pendingData } = useQuery({
    queryKey: ["approvals", activeDomain, "pending"],
    queryFn: () => api.getApprovals(activeDomain!, { status: "pending" }),
    enabled: !!activeDomain,
    refetchInterval: 15_000,
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => api.approve(activeDomain!, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["approvals", activeDomain] });
      queryClient.invalidateQueries({ queryKey: ["dashboard", activeDomain] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, feedback }: { id: string; feedback?: string }) =>
      api.reject(activeDomain!, id, feedback),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["approvals", activeDomain] });
      queryClient.invalidateQueries({ queryKey: ["dashboard", activeDomain] });
    },
  });

  const approveAllLowRisk = useMutation({
    mutationFn: async () => {
      const lowRiskItems = (data?.proposals ?? []).filter(
        (p) => p.riskTier === "low" && p.status === "pending",
      );
      await Promise.all(
        lowRiskItems.map((p) => api.approve(activeDomain!, p.id)),
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["approvals", activeDomain] });
      queryClient.invalidateQueries({ queryKey: ["dashboard", activeDomain] });
    },
  });

  return {
    proposals: data?.proposals ?? [],
    count: data?.count ?? 0,
    pendingCount: pendingData?.count ?? 0,
    isLoading,
    error,
    approve: approveMutation.mutate,
    reject: rejectMutation.mutate,
    approveAllLowRisk: approveAllLowRisk.mutate,
    isApproving: approveMutation.isPending,
    isRejecting: rejectMutation.isPending,
    isBulkApproving: approveAllLowRisk.isPending,
  };
}

export function getRiskColor(risk?: string): string {
  switch (risk?.toLowerCase()) {
    case "low":
      return "bg-cf-risk-low/15 text-cf-risk-low border-cf-risk-low/30";
    case "medium":
      return "bg-cf-risk-medium/15 text-cf-risk-medium border-cf-risk-medium/30";
    case "high":
      return "bg-cf-risk-high/15 text-cf-risk-high border-cf-risk-high/30";
    default:
      return "bg-cf-bg-tertiary text-cf-text-muted border-cf-border";
  }
}

export function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diffMs = now - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
