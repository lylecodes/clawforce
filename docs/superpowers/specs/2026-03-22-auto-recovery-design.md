# Auto-Recovery for Disabled Agents — Design Spec

## Problem

When an agent hits the consecutive failure threshold, ClawForce auto-disables it. This is correct safety behavior — but currently the agent stays disabled forever until a human manually re-enables it via SQL. For transient issues (model rate limits, temporary infra problems, bad task batch), this creates unnecessary downtime.

## Solution

Add a configurable cooldown-based auto-recovery mechanism. After a disabled agent's cooldown period expires, the sweep service automatically re-enables it and resets its failure state. If the agent keeps failing and gets disabled again, an escalation event is emitted.

## Config Schema

New `auto_recovery` field on agent config in `src/types.ts`:

```typescript
interface AgentConfig {
  // ... existing fields
  auto_recovery?: {
    enabled: boolean;
    cooldown_minutes: number; // default: 10
  };
}
```

When `auto_recovery` is not set, behavior is unchanged (agent stays disabled until manual intervention). When enabled, the sweep will auto-re-enable the agent after `cooldown_minutes` have passed since the disable timestamp.

## Implementation

### 1. Sweep Recovery Check

Add a disabled agent recovery check to the sweep service in `src/sweep/actions.ts`. On each sweep tick:

1. Query `disabled_agents` table for agents with `auto_recovery.enabled = true`
2. For each, check if `current_time - disabled_at >= cooldown_minutes`
3. If cooldown has elapsed, re-enable the agent:
   - Remove from `disabled_agents` table via `src/enforcement/disabled-store.ts`
   - Reset the consecutive failure window — delete recent failed `audit_runs` entries or insert a "recovery" marker row that breaks the consecutive failure chain
   - Log: `"Auto-recovered agent <name> after <N>m cooldown"`

### 2. Orchestrator Notification

Add `agent_disabled` to the events that the orchestrator's `observe` pattern can match. This allows the orchestrator agent to be notified when a team member is disabled, giving it the option to reassign work or adjust priorities.

The event payload should include:
- Agent ID
- Disable reason
- Whether auto-recovery is configured
- Expected recovery time (if auto-recovery enabled)

### 3. Recurring Escalation

If an agent remains disabled past 2x its cooldown period (e.g., it was auto-recovered but immediately failed and got disabled again), emit an escalation event:

- Event type: `agent_recovery_escalation`
- Payload: agent ID, total disable duration, number of recovery attempts
- This surfaces persistent failures to the orchestrator or human operator

### 4. Failure Counter Reset

When re-enabling an agent, the consecutive failure counter must be cleanly reset so the agent isn't immediately re-disabled on its first new failure. Two approaches:

- **Preferred**: Insert a "recovery" marker into `audit_runs` that breaks the consecutive failure window
- **Alternative**: Delete the agent's recent failed `audit_runs` entries (loses audit history)

## Critical Files

- `src/sweep/actions.ts` — add disabled agent recovery check to sweep tick
- `src/enforcement/disabled-store.ts` — disable/re-enable operations, query by cooldown
- `src/safety.ts` — consecutive failure logic, reset mechanism
- `src/types.ts` — add `auto_recovery` to `AgentConfig` type definition

## Acceptance Criteria

- Disabled agent with `auto_recovery: { enabled: true, cooldown_minutes: 10 }` is automatically re-enabled after 10 minutes
- Sweep service handles the recovery check on each tick
- Consecutive failure counter is reset on recovery so the agent gets a clean slate
- Orchestrator receives `agent_disabled` event via its observe pattern
- If agent stays disabled past 2x cooldown, an escalation event is emitted
- No manual SQL intervention needed for transient failures
- Agents without `auto_recovery` configured remain disabled until manually re-enabled (backward compatible)
