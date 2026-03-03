/**
 * Clawforce skill topic — Approval
 *
 * Documents the proposal/approval workflow.
 */

export function generate(): string {
  const sections: string[] = [
    "# Approval System",
    "",
    "The approval system enables human-in-the-loop control over agent actions. Agents submit proposals, and managers or humans approve or reject them.",
    "",

    "## Approval Policy",
    "",
    "The approval policy is defined at the project level in `project.yaml`:",
    "",
    "```yaml",
    "approval:",
    "  policy: >-",
    "    Approve proposals that are well-scoped and have clear success criteria.",
    "    Reject proposals that are too broad, risky, or lack justification.",
    "```",
    "",
    "The `policy` field is natural language text that is served to the manager at decision time via `get_approval_context`. It guides how the manager should evaluate proposals.",
    "",

    "## Proposal Flow",
    "",
    "1. **Agent submits proposal**: `clawforce_task submit_proposal` — creates a proposal with a title, description, and optional risk tier",
    "2. **Proposal enters pending state**: The proposal is stored with status `pending`",
    "3. **Manager reviews**: The manager sees pending proposals in the `proposals` context source",
    "4. **Manager gets context**: `clawforce_task get_approval_context` — returns the proposal details along with the approval policy",
    "5. **Manager decides**: Approve or reject the proposal",
    "6. **Agent checks status**: `clawforce_task check_proposal` — polls for the resolution",
    "",

    "## Proposal Statuses",
    "",
    "| Status | Description |",
    "| --- | --- |",
    "| `pending` | Awaiting review |",
    "| `approved` | Manager approved — agent can proceed |",
    "| `rejected` | Manager rejected — agent should not proceed |",
    "",

    "## Slash Commands",
    "",
    "For human operators interacting through messaging channels:",
    "",
    "| Command | Description |",
    "| --- | --- |",
    "| `/clawforce-proposals` | List all pending proposals for the project |",
    "| `/clawforce-approve <id> [feedback]` | Approve a proposal, optionally with feedback |",
    "| `/clawforce-reject <id> [feedback]` | Reject a proposal, optionally with feedback |",
    "",

    "## Manager Approval Flow",
    "",
    "Managers use `clawforce_task get_approval_context` to get the full context for making a decision:",
    "",
    "- The proposal title and description",
    "- Who submitted it and when",
    "- The project's approval policy text",
    "- The risk tier (if classified)",
    "- Any user feedback from previous resolutions",
    "",
    "The manager then uses their judgment (guided by the policy) to approve or reject.",
    "",

    "## Integration with Risk Tiers",
    "",
    "When risk tiers are enabled, high-risk actions automatically generate proposals:",
    "",
    "- **`approval` gate**: Creates a proposal that a manager can approve",
    "- **`human_approval` gate**: Creates a proposal that requires human approval (not just a manager agent)",
    "",
    "The risk-gated proposal includes the risk classification reasons, helping the reviewer understand why approval was requested.",
    "",
  ];

  return sections.join("\n");
}
