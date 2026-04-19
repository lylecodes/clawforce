import { approveProposal, rejectProposal } from "../../approval/resolve.js";

export type ResolveApprovalCommandResult = {
  status: number;
  body: unknown;
  resolution?: "approved" | "rejected";
};

export function runResolveApprovalCommand(
  projectId: string,
  proposalId: string,
  action: "approve" | "reject",
  feedback?: string,
): ResolveApprovalCommandResult {
  if (action === "approve") {
    const result = approveProposal(projectId, proposalId, feedback);
    if (!result) {
      return {
        status: 404,
        body: { error: `Proposal ${proposalId} not found or already resolved` },
      };
    }
    return {
      status: 200,
      body: result,
      resolution: "approved",
    };
  }

  const result = rejectProposal(projectId, proposalId, feedback);
  if (!result) {
    return {
      status: 404,
      body: { error: `Proposal ${proposalId} not found or already resolved` },
    };
  }
  return {
    status: 200,
    body: result,
    resolution: "rejected",
  };
}
