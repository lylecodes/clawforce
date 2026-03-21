# Auto Lifecycle — Design Spec

## Problem

ClawForce currently relies on agents calling governance tools (clawforce_task, clawforce_log) to transition tasks and log work. This is:
- **Expensive** — non-compliance triggers retries, each a full LLM session
- **Unreliable** — agents forget/ignore tool calls despite expectations
- **Wasteful** — tool descriptions consume context tokens for tools the agent shouldn't use

## Solution

Automate the mandatory lifecycle. ClawForce handles governance plumbing. Agents just do work.

## New Flow: Employee Dispatch

```
BEFORE (current):
  Agent dispatched → agent must call clawforce_task transition →
  agent does work → agent must call clawforce_log →
  agent must call clawforce_task attach_evidence →
  agent must call clawforce_task transition to REVIEW →
  compliance check → retry if any missed → repeat

AFTER (auto lifecycle):
  1. ClawForce auto-transitions task → IN_PROGRESS
  2. Agent context says: "Do the work. We handle task tracking."
  3. Agent does the actual work (uses project tools only)
  4. Session ends → ClawForce at agent_end:
     a. Auto-captures agent's last substantive output as evidence
     b. Injects follow-up: "Summarize what you did in 2-3 sentences"
     c. Agent responds with summary → auto-logged via clawforce_log
     d. Auto-transitions task → REVIEW
  5. Done. No retries needed for governance plumbing.
```

## Tool Scoping Changes

### Employee agents (qs-ops, qs-dev)
**Before:** 10 ClawForce tools (50 actions) in context
**After:**
- `clawforce_message` — communicate with manager (blocked, need help, found something)
- That's it. Zero task/log/ops tools.

### Manager agents (qs-lead)
**No change.** Managers still need:
- `clawforce_task` — create, assign, review, transition
- `clawforce_ops` — dispatch, agent management
- `clawforce_log` — log decisions
- `clawforce_message` — communicate with team
- `clawforce_goal` — goal management

## Implementation

### 1. Auto-transition on dispatch (before_prompt_build)

In the OpenClaw adapter's `before_prompt_build` hook, when a dispatch context is detected:

```typescript
// After detecting dispatch context:
if (dispatchCtx) {
  const task = getTask(session.projectId, dispatchCtx.taskId);
  if (task && task.state === "ASSIGNED") {
    transitionTask(session.projectId, dispatchCtx.taskId, "IN_PROGRESS", {
      actor: agentId,
      reason: "auto-transition on dispatch",
    });
  }
}
```

### 2. Auto-capture evidence + summary at agent_end

In the OpenClaw adapter's `agent_end` hook, when a dispatch context is present:

```typescript
if (session.dispatchContext) {
  const { taskId } = session.dispatchContext;

  // a. Capture last tool output as evidence
  const lastOutput = session.metrics.toolCalls
    .filter(tc => tc.success)
    .pop();
  if (lastOutput) {
    attachEvidence(session.projectId, taskId, {
      type: "output",
      content: lastOutput.result ?? "Task completed",
      actor: session.agentId,
    });
  }

  // b. Inject summary prompt
  const summaryResponse = await api.injectAgentMessage({
    sessionKey: ctx.sessionKey,
    message: "Summarize what you accomplished in 2-3 sentences. Be specific about what changed.",
  });

  // c. Auto-log the summary
  writeLog({
    projectId: session.projectId,
    agentId: session.agentId,
    category: "outcome",
    content: summaryResponse ?? "Session completed",
  });

  // d. Auto-transition to REVIEW
  transitionTask(session.projectId, taskId, "REVIEW", {
    actor: session.agentId,
    reason: "auto-transition on session completion",
  });
}
```

### 3. Employee tool scope

In `src/profiles.ts`, update the employee preset:

```typescript
employee: {
  // ... existing config ...
  // Remove all ClawForce tools except messaging
  tools: ["clawforce_message"],
  // Remove compliance expectations (lifecycle is automated)
  expectations: [],
  performance_policy: { action: "alert" },  // No retry needed
}
```

Or better: create a new scope in `DEFAULT_ACTION_SCOPES`:

```typescript
employee: {
  clawforce_message: ["send", "list", "read", "reply"],
  // Nothing else — task/log/ops/verify/workflow all removed
}
```

### 4. Context update

Employee SOUL.md and briefing should say:

```
ClawForce handles task tracking automatically:
- Your task is transitioned to IN_PROGRESS when you start
- Your output is captured as evidence when you finish
- You'll be asked for a brief summary at the end
- The task moves to REVIEW automatically

Focus on the work. Use clawforce_message if you're blocked or need help.
```

### 5. Manager stays the same

Manager still has full tools. The manager creates tasks, assigns them, reviews completed work, dispatches agents. This is intentional — the manager IS the governance interface. Employees are the workers.

## What this eliminates

- Employee compliance expectations (no more checking if they called tools)
- Employee retries (no more re-running sessions for missed tool calls)
- ClawForce tool descriptions in employee context (~3KB saved per session)
- "Use clawforce_task to transition" instructions in prompts
- The entire retry→re-inject→re-run cycle for employees

## What this keeps

- Manager tool usage (managers still call tools directly)
- Manager compliance (managers should log decisions)
- Task state machine (states still enforced, just transitioned automatically)
- Evidence capture (automated instead of manual)
- Audit trail (all auto-transitions logged with actor + reason)
- Cost tracking (unchanged)

## Edge cases

- **Agent wants to create a sub-task**: Can't — only managers can. Agent messages manager instead.
- **Agent finds a blocker**: Uses `clawforce_message` to tell manager. Manager decides what to do.
- **Agent needs to fail the task**: Agent says "this can't be done because X" in its summary. Manager reviews and decides.
- **Agent's work is incomplete**: Auto-transitions to REVIEW anyway. Manager rejects and reassigns.
- **Session crashes/times out**: agent_end still fires, auto-transitions to REVIEW with evidence "session timed out." Manager sees it.
