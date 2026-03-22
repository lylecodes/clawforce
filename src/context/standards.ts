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

When creating tasks, follow these standards:

1. **Clear title**: Use action-oriented titles that describe the deliverable (e.g., "Implement user auth endpoint" not "Auth work").
2. **Description with acceptance criteria**: Every task description must include what "done" looks like. Use a checklist if multiple criteria.
3. **Appropriate priority**: P0 = production down, P1 = blocks other work, P2 = normal, P3 = nice to have.
4. **Assignment**: Assign to the agent best suited by skill and current workload. Check available capacity before assigning.
5. **Tags**: Add relevant tags for filtering (e.g., "frontend", "bugfix", "infrastructure").
6. **Deadline**: Set deadlines for P0/P1 tasks. P2/P3 tasks may omit deadlines.
7. **Dependencies**: If the task depends on other tasks, create them in the correct workflow phase or note blockers.
8. **No duplicate tasks**: Check the task board before creating. If a similar task exists, update it instead.`;
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
4. **No lifecycle management**: Do not call task transition, evidence attachment, or logging tools. The system handles lifecycle automatically when your session ends.
5. **Quality over speed**: Ensure your output is correct and complete. Incomplete work will be sent back for revision.
6. **Final summary**: End your session with a clear summary of what you accomplished, any issues encountered, and anything the reviewer should check.`;
}

/**
 * Standards for reviewing completed tasks (injected for managers).
 */
export function getReviewStandards(): string {
  return `## Review Standards

When reviewing tasks in REVIEW state, follow these standards:

1. **Check evidence**: Read the attached evidence before making a decision. Every REVIEW task should have evidence attached.
2. **Verify acceptance criteria**: Compare the evidence against the task's description and acceptance criteria.
3. **Test if applicable**: If the task involved code changes, verify tests pass or run relevant checks.
4. **Approve (DONE) or reject (IN_PROGRESS)**: Transition to DONE if criteria are met. Transition back to IN_PROGRESS with a clear reason if not.
5. **Never skip review**: Do not transition directly from IN_PROGRESS to DONE. The REVIEW state exists for quality control.
6. **Provide feedback on rejection**: When rejecting, attach evidence explaining what needs to change. Be specific and actionable.
7. **Timely reviews**: Review tasks promptly. Tasks stuck in REVIEW block the assigned agent from picking up new work.`;
}

/**
 * Standards for handling rejected tasks (injected for managers).
 */
export function getRejectionStandards(): string {
  return `## Rejection Standards

When rejecting a task (transitioning REVIEW back to IN_PROGRESS), follow these standards:

1. **Specific feedback**: Explain exactly what is wrong or missing. Reference specific files, lines, or outputs.
2. **Actionable next steps**: Tell the assignee what to do differently. "Fix the bug" is not actionable; "The auth middleware returns 403 instead of 401 for expired tokens — update the status code in middleware/auth.ts" is.
3. **Severity assessment**: Is this a minor fix or a fundamental rethinking? Set expectations for the rework scope.
4. **Attach rejection evidence**: Use evidence attachment to document what you found wrong. This creates an audit trail.
5. **Consider reassignment**: If the task has been rejected multiple times, consider whether the assigned agent has the right skills. Reassign if needed.
6. **Track patterns**: If an agent's work is repeatedly rejected, address it through coaching or role adjustment rather than endless rejection cycles.`;
}
