/**
 * Clawforce — Paradigm standards
 *
 * Returns markdown context strings for task creation, execution, review,
 * and rejection standards. Used as context sources to inject governance
 * standards into agent sessions.
 */

/**
 * Standards for creating well-formed tasks (injected for managers).
 */
export function getTaskCreationStandards(): string {
  return `## Task Creation Standards

Every task needs: action-oriented title, acceptance criteria (what done looks like), priority P0-P3, assignee by skill+workload. Check board for dupes first.`;
}

/**
 * Standards for executing assigned tasks (injected into dispatch prompt for employees).
 */
export function getExecutionStandards(): string {
  return `## Execution Standards

You are executing a dispatched task. Follow these standards:

1. **Focus on the task**: Complete the assigned task only. Do not create new tasks, transition other tasks, or modify the project structure.
2. **Show your work**: Use tools to produce concrete output (code, files, test results). The system automatically captures your tool outputs as evidence.
3. **Handle errors**: If you encounter errors, debug and retry. If the task is impossible, explain why clearly in your final message.
4. **No lifecycle management**: Do not call task transition or evidence attachment actions. The system handles lifecycle automatically when your session ends. You may still use \`clawforce_log write\` when the task or your role explicitly requires it, or when you need to surface a finding.
5. **Quality over speed**: Ensure your output is correct and complete. Incomplete work will be sent back for revision.
6. **Final summary**: End your session with a clear summary of what you accomplished, any issues encountered, and anything the reviewer should check.
7. **Surface findings**: If you discover something unexpected — a bug in related code, a missing API, a design concern — use clawforce_log write with category 'finding' to surface it to your manager.`;
}

/**
 * Standards for reviewing completed tasks (injected for verifiers).
 */
export function getReviewStandards(): string {
  return `## Review Standards

Read evidence. Verify acceptance criteria met. Check tests pass. Approve (DONE) or reject (IN_PROGRESS) with specific feedback (file, line, what to change). Attach rejection evidence. If repeatedly rejected, flag to lead.`;
}

/**
 * @deprecated Folded into review_standards. Kept for backward compatibility — returns empty string.
 */
export function getRejectionStandards(): string {
  return "";
}
