# Auto Lifecycle — Design Spec (v2)

## Problem

ClawForce currently relies on agents calling governance tools (clawforce_task, clawforce_log) to manage task lifecycle. This is expensive (retries cost full LLM sessions), unreliable (agents forget tool calls), and wasteful (tool descriptions consume context for tools agents shouldn't use).

## Core Principle

**Governance is structural, not LLM-dependent.** ClawForce automates the mandatory lifecycle. Agents just do work. The manager is the verification layer.

## The Paradigm

ClawForce ships with opinionated defaults — the "paradigm" — that define how teams operate. Everything is configurable, but the defaults work out of the box.

```
ClawForce paradigm (presets) — opinionated defaults
  ↓ overridden by
Domain config (domain.yaml) — project-specific
  ↓ overridden by
Agent config (per-agent) — individual overrides
```

---

## Auto Lifecycle Flow

```
1. Manager creates task with explicit output requirements
2. ClawForce dispatches employee → auto-transitions ASSIGNED → IN_PROGRESS
3. Employee does work (project tools only, zero ClawForce tools)
4. Session ends → ClawForce auto-captures evidence (tool outputs + last message)
5. ClawForce auto-transitions → REVIEW
6. Manager dispatched to review evidence
7. Manager reviews:
   a. Sufficient → approves → DONE
   b. Insufficient → rejects with specific questions → follow-up task to same employee
   c. Failed → marks FAILED, reassigns or creates new task
8. Loop if rejected
```

---

## Implementation

### 1. Auto-transition on dispatch

**Where:** `before_prompt_build` hook in `adapters/openclaw.ts`

When dispatch context is detected and task is ASSIGNED:
```typescript
transitionTask(projectId, taskId, "IN_PROGRESS", {
  actor: agentId,
  reason: "auto-transition on dispatch",
});
```

Pure database update. No LLM call.

### 2. Auto-capture evidence

**Where:** `after_tool_call` hook + `agent_end` hook in `adapters/openclaw.ts`

**During session (`after_tool_call`):**
- Buffer significant tool outputs (Bash, Write, Edit results) in session tracker
- New field on SessionMetrics: `significantResults: Array<{ toolName, action, resultPreview }>`
- Capped at 5 entries, each truncated to 2000 chars
- "Significant" tools: Bash, Write, Edit, and any tool producing output > 100 chars

**At session end (`agent_end`):**
- Extract last assistant message from `event.messages` transcript
- Combine buffered tool outputs + last assistant message
- Auto-attach as evidence to the task:
```typescript
attachEvidence(projectId, taskId, {
  type: "output",
  content: formatEvidence(significantResults, lastAssistantMessage),
  actor: agentId,
});
```

Pure data extraction + database write. No LLM call.

### 3. Auto-transition to REVIEW

**Where:** `agent_end` hook in `adapters/openclaw.ts`

After evidence is attached:
```typescript
// Determine outcome from session metrics
if (session.metrics.errorCount > session.metrics.toolCalls.length * 0.5) {
  // High error rate — probable failure
  transitionTask(projectId, taskId, "FAILED", {
    actor: agentId,
    reason: "session had high error rate",
  });
} else if (session.metrics.toolCalls.length === 0) {
  // Zero tool calls — agent never started
  transitionTask(projectId, taskId, "FAILED", {
    actor: agentId,
    reason: "session completed without action",
  });
} else {
  // Normal completion — send to review
  transitionTask(projectId, taskId, "REVIEW", {
    actor: agentId,
    reason: "auto-transition on session completion",
  });
}
```

Then trigger immediate manager dispatch:
```typescript
processEvents(projectId);
```

This fires `task_review_ready` → manager gets dispatched for review.

### 4. Manager-as-verifier

When qs-lead is dispatched to review a task, it sees:
- The task with its description and acceptance criteria
- The auto-captured evidence (tool outputs + agent's last message)
- Trust score history for the employee

The manager then:
- Verifies evidence against acceptance criteria
- Approves (→ DONE) if satisfied
- Rejects with specific follow-up questions (creates new task to same employee)

If the manager needs more information, it creates a follow-up task:
```
Task: "Re: System health check — clarification needed"
Description: "Your health check output didn't include RDS connection status. Run: python -c 'import psycopg2; ...' and paste the output."
Assigned to: qs-ops
```

The employee gets dispatched again in a fresh session with its own identity and memory intact.

---

## Employee Tool Scoping

### Before (current)
10 ClawForce tools, 50 actions in context (~3KB of tool descriptions)

### After
**Zero ClawForce tools.** Employee only has project tools (Bash, Read, Write, Grep, etc.)

The employee's context says:
```
You have been assigned a task. Read the description carefully.
Do exactly what it says. Show your work — paste raw command output.
Your output will be reviewed by your manager.
ClawForce handles task tracking automatically.
```

No governance ceremony. No tool confusion. Pure execution.

### Manager tools (unchanged)
- `clawforce_task` — create, assign, review, transition, attach evidence
- `clawforce_ops` — dispatch, agent management, queue status
- `clawforce_log` — log decisions and outcomes
- `clawforce_message` — communicate with team
- `clawforce_goal` — goal management

---

## Paradigm Standards (preset defaults)

### Task Creation Standards (manager preset)
Injected into manager context. Overridable via config.

```
## Task Creation Standards

When creating tasks:
- Title: actionable verb + noun ("Run health check", "Fix login bug")
- Description: what to do + why + acceptance criteria
- Output format: specify EXACTLY what output you need for verification
- Priority: justified by impact (P0=system down, P1=blocking work, P2=important, P3=nice to have)
- Assignment: match the task domain to the agent's expertise

Example:
  Title: "Check IB Gateway connectivity"
  Description: "Verify IB Gateway is connected and accepting orders.

  Acceptance criteria:
  - Show socat tunnel status (port 4002→4004)
  - Show IB connection state from gateway logs
  - Confirm client ID is not in use

  Output format:
  - Paste raw command output for each check
  - End with: CONNECTED or DISCONNECTED"
```

### Execution Standards (employee preset)
Injected into employee context via dispatch prompt. Overridable via config.

```
## Execution Standards

- Follow the task description exactly
- Show raw output — paste actual command results, not summaries
- If something fails, show the full error output
- If the task says "run X", paste the output of X
- Do not add unrequested work
- Do not skip steps in the task description
```

### Review Standards (manager preset)
Injected into manager context when reviewing. Overridable via config.

```
## Review Standards

When reviewing a completed task:
- Check every acceptance criterion in the original task description
- Verify raw evidence matches the agent's claims
- If output format doesn't match the spec, reject immediately
- If evidence is missing for any criterion, reject with specific ask
- Approval means "I verified this is correct" — not "looks fine"
- Rejection must cite the specific criterion not met and what you need
```

### Rejection Standards (manager preset)
```
## Rejection Standards

When rejecting a task:
- Create a follow-up task to the SAME employee
- Title: "Re: [original task title] — [what's needed]"
- Description: cite the specific criterion not met, ask for exactly what you need
- Do not reject with "try again" — reject with "show me X"
```

---

## Configuration

All paradigm standards live in presets as default briefing content. They're injected as context sources that can be overridden at domain or agent level.

New context sources:
- `task_creation_standards` — injected for managers when no job context (general session)
- `execution_standards` — injected for employees via dispatch prompt
- `review_standards` — injected for managers when reviewing tasks
- `rejection_standards` — injected for managers when reviewing tasks

These are STATIC sources (cacheable per session) since they don't change between turns.

---

## What This Eliminates

- Employee compliance expectations (no tool usage to check)
- Employee retries (no re-running sessions for missed tool calls)
- ClawForce tool descriptions in employee context (~3KB saved)
- "Use clawforce_task to transition" instructions
- Generic debrief templates
- Automated summary prompts (manager handles this through review)
- `clawforce_signal` tool (not needed — manager reviews evidence directly)

## What This Keeps

- Manager tool usage (managers still call tools directly)
- Manager compliance (managers should log decisions)
- Task state machine (transitions automated for employees, manual for managers)
- Evidence capture (automated via tool output buffering)
- Audit trail (all auto-transitions logged with actor + reason)
- Cost tracking (unchanged)
- Trust scoring (based on manager approval/rejection patterns)

## Edge Cases

- **Employee can't complete the task**: employee's output shows errors/failures → evidence captures it → manager reviews and sees the failure → creates appropriate follow-up or marks FAILED
- **Employee does extra work**: fine — evidence shows what was done. Manager reviews and decides if it's relevant
- **Session crashes/times out**: `agent_end` still fires → auto-transitions to REVIEW with whatever evidence was captured → manager reviews "session timed out" evidence
- **Manager rejects multiple times**: each rejection creates a follow-up task → trust score for that employee decreases → eventually manager might reassign to different agent
- **No evidence captured**: (zero tool calls) → auto-transitions to FAILED → manager investigates
