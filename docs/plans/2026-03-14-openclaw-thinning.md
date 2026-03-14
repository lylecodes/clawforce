# OpenClaw Thinning Initiative — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formalize the governance/runtime boundary — strip runtime config from Clawforce, delegate plumbing to OpenClaw, create an OpenClaw config reader for when Clawforce needs runtime data.

**Architecture:** Clawforce becomes a pure governance layer. Runtime fields (model, provider) removed from config types. New `openclaw-reader.ts` provides runtime data when needed. Memory flush timing, cost computation, and channel delivery delegated to OpenClaw. Cron type redefinitions deleted.

**Tech Stack:** TypeScript, vitest, existing Clawforce + OpenClaw plugin-sdk infrastructure

**Reference:** Design spec at `docs/plans/2026-03-14-openclaw-thinning-design.md`

---

## Chunk 1: Foundation — OpenClaw Config Reader + Type Stripping

### Task 1: OpenClaw Config Reader

Everything else depends on this utility — it provides runtime agent data (model, pricing, rate limits) after we strip runtime fields from Clawforce's own types.

**Files:**
- Create: `src/config/openclaw-reader.ts`
- Test: `test/config/openclaw-reader.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/config/openclaw-reader.test.ts`:

```typescript
import { afterEach, describe, expect, it } from "vitest";
import {
  setOpenClawConfig,
  getAgentModel,
  getAgentTools,
  getModelPricing,
  clearOpenClawConfigCache,
} from "../../src/config/openclaw-reader.js";

describe("openclaw-reader", () => {
  afterEach(() => {
    clearOpenClawConfigCache();
  });

  it("returns agent model from config", () => {
    setOpenClawConfig({
      agents: {
        list: [{ id: "lead", model: { primary: "claude-opus-4-6" } }],
        defaults: { model: "claude-sonnet-4-6" },
      },
    });
    expect(getAgentModel("lead")).toBe("claude-opus-4-6");
  });

  it("falls back to default model", () => {
    setOpenClawConfig({
      agents: {
        list: [{ id: "worker" }],
        defaults: { model: "claude-sonnet-4-6" },
      },
    });
    expect(getAgentModel("worker")).toBe("claude-sonnet-4-6");
  });

  it("returns null for unknown agent", () => {
    setOpenClawConfig({ agents: { list: [], defaults: {} } });
    expect(getAgentModel("nobody")).toBeNull();
  });

  it("returns model pricing", () => {
    setOpenClawConfig({
      models: {
        providers: [
          {
            id: "anthropic",
            models: [
              {
                id: "claude-opus-4-6",
                cost: { input: 1500, output: 7500 },
              },
            ],
          },
        ],
      },
    });
    const pricing = getModelPricing("claude-opus-4-6");
    expect(pricing).toEqual({ inputPer1M: 1500, outputPer1M: 7500 });
  });

  it("returns null for unknown model pricing", () => {
    setOpenClawConfig({ models: { providers: [] } });
    expect(getModelPricing("unknown")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/openclaw-reader.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the openclaw-reader module**

Create `src/config/openclaw-reader.ts`:

```typescript
/**
 * Clawforce — OpenClaw Config Reader
 *
 * Cached reader for OpenClaw agent runtime config (model, pricing, rate limits).
 * Used when Clawforce needs runtime data it no longer stores itself.
 *
 * Cache loaded at gateway_start, invalidated on config watcher reload.
 * Used on warm paths (cost estimation, capacity), NOT hot paths (dispatch gates use own counters).
 */

type OpenClawAgentEntry = {
  id: string;
  model?: { primary?: string };
  tools?: string[];
  [key: string]: unknown;
};

type OpenClawModelEntry = {
  id: string;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  [key: string]: unknown;
};

type OpenClawProviderEntry = {
  id: string;
  models?: OpenClawModelEntry[];
  rpm?: number;
  tpm?: number;
  [key: string]: unknown;
};

type OpenClawConfigSnapshot = {
  agents?: {
    list?: OpenClawAgentEntry[];
    defaults?: { model?: string; [key: string]: unknown };
  };
  models?: {
    providers?: OpenClawProviderEntry[];
  };
  [key: string]: unknown;
};

let cachedConfig: OpenClawConfigSnapshot | null = null;

/** Set the cached config (called at gateway_start or on config reload). */
export function setOpenClawConfig(config: OpenClawConfigSnapshot): void {
  cachedConfig = config;
}

/** Clear the cache (for testing or forced refresh). */
export function clearOpenClawConfigCache(): void {
  cachedConfig = null;
}

/** Get the model for an agent. Falls back to agent defaults. */
export function getAgentModel(agentId: string): string | null {
  if (!cachedConfig?.agents) return null;

  const agent = cachedConfig.agents.list?.find((a) => a.id === agentId);
  if (agent?.model?.primary) return agent.model.primary;

  return cachedConfig.agents.defaults?.model ?? null;
}

/** Get the tools list for an agent. */
export function getAgentTools(agentId: string): string[] | null {
  if (!cachedConfig?.agents) return null;
  const agent = cachedConfig.agents.list?.find((a) => a.id === agentId);
  return agent?.tools ?? null;
}

/** Get pricing for a model (cents per 1M tokens). */
export function getModelPricing(
  modelId: string,
): { inputPer1M: number; outputPer1M: number } | null {
  if (!cachedConfig?.models?.providers) return null;

  for (const provider of cachedConfig.models.providers) {
    const model = provider.models?.find((m) => m.id === modelId);
    if (model?.cost) {
      return {
        inputPer1M: model.cost.input ?? 0,
        outputPer1M: model.cost.output ?? 0,
      };
    }
  }

  return null;
}

/** Get rate limits for a provider. */
export function getProviderRateLimits(
  providerId: string,
): { rpm: number; tpm: number } | null {
  if (!cachedConfig?.models?.providers) return null;

  const provider = cachedConfig.models.providers.find((p) => p.id === providerId);
  if (!provider || (!provider.rpm && !provider.tpm)) return null;

  return {
    rpm: provider.rpm ?? 0,
    tpm: provider.tpm ?? 0,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/openclaw-reader.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/openclaw-reader.ts test/config/openclaw-reader.test.ts
git commit -m "feat(thinning): add OpenClaw config reader for runtime data lookups"
```

---

### Task 2: Strip Runtime Fields from Types

Remove `model` and `provider` from `GlobalAgentDef`, `GlobalDefaults`, and `AgentConfig`. Keep `tools`, `persona`, `channel`, `compaction`.

**Files:**
- Modify: `src/config/schema.ts:12-28`
- Modify: `src/types.ts:263-313`

- [ ] **Step 1: Remove `model` from `GlobalAgentDef`**

In `src/config/schema.ts:12-19`, remove the `model` field (line 14). The type becomes:

```typescript
export type GlobalAgentDef = {
  extends?: string;
  persona?: string;
  title?: string;
  skillCap?: number;
  [key: string]: unknown;
};
```

- [ ] **Step 2: Remove `model` from `GlobalDefaults`**

In `src/config/schema.ts:21-28`, remove the `model` field (line 22). The type becomes:

```typescript
export type GlobalDefaults = {
  performance_policy?: {
    action: "retry" | "alert" | "terminate_and_alert";
    max_retries?: number;
    then?: string;
  };
};
```

- [ ] **Step 3: Remove `model` and `provider` from `AgentConfig`**

In `src/types.ts`, remove these two fields from `AgentConfig`:
- `model?: string;` (line 269)
- `provider?: string;` (line 271)

Keep all other fields including `tools`, `persona`, `channel`, `compaction`.

- [ ] **Step 4: Fix compilation errors**

Run `npx tsc --noEmit 2>&1 | head -50` to find all references to the removed fields. Common patterns to fix:

- Any test that creates an `AgentConfig` with `model` — remove the field or move it to a comment
- Any code that reads `config.model` — replace with `getAgentModel()` from openclaw-reader
- Any code that reads `config.provider` — replace with `getAgentModel()` and derive provider from model string

**Strategy:** Run `npx tsc --noEmit 2>&1 | head -80` after each file change to catch errors incrementally. Do NOT try to fix everything at once.

Key source files to update (work through one at a time, verify compilation after each):
- `src/config/init.ts:130-132` — delete the `global.defaults?.model` fallback block entirely (3 lines)
- `src/agent-sync.ts:71-73` — delete the `if (config.model) { entry.model = ... }` block. Do NOT replace with `getAgentModel()` — that would create a circular dependency (reading from OpenClaw to write back to OpenClaw). After thinning, `buildOpenClawAgentEntry()` simply stops setting model. OpenClaw owns model config directly.
- `src/events/router.ts:578` — replace `agentEntry?.config.model` with `getAgentModel(task.assignedTo!)` (import from `../config/openclaw-reader.js`)
- `src/config-validator.ts:385-391` — delete the existing `config.model` empty-string validation (field no longer exists on the type). Task 3 will add rejection logic for model as a separate step.
- `src/profiles.ts` — verify no `model` references exist (confirmed clean, but check)

Key test files to update (remove `model` from AgentConfig/GlobalAgentDef test objects):
- `test/agent-sync.test.ts` — ~4 occurrences of `model: "claude-opus-4-6"` in `makeAgentConfig()`
- `test/config/registry.test.ts` — `model` in GlobalAgentDef literal
- `test/config/init.test.ts` — `global.defaults.model` fallback tests
- `test/config/watcher.test.ts` — `model: "old-model"` in GlobalAgentDef
- Any other file flagged by `npx tsc --noEmit`

Note: `model` on `JobDefinition`, `PlannedItem`, and `recordCost()` params stays — those are governance-level overrides, not agent config.

- [ ] **Step 5: Run tests to find remaining failures**

Run: `npx vitest run`

Fix test failures by removing `model` from test AgentConfig objects. Many tests create configs like:
```typescript
const config: AgentConfig = { model: "test-model", ... }
```
Remove the `model` field from these. If the test actually needs model data, use `setOpenClawConfig()` from the reader instead.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts src/types.ts src/config/init.ts src/agent-sync.ts src/events/router.ts
# Include all other files that were fixed for compilation
git commit -m "refactor(thinning): strip model/provider from Clawforce config types"
```

---

### Task 3: Config Validation — Reject Runtime Fields

Add validation that rejects `model` and `provider` in Clawforce config with a clear migration message.

**Files:**
- Modify: `src/config-validator.ts`
- Test: existing config validation tests

- [ ] **Step 1: Add rejection logic**

In `src/config-validator.ts`, add a check in the agent config validation section. When processing each agent's raw config, check for `model` or `provider` fields:

```typescript
// In the agent validation loop, after existing checks:
if (config.model !== undefined) {
  warnings.push({
    level: "error",
    agentId,
    message: `"model" is a runtime setting — configure it in OpenClaw's agent config (~/.openclaw/ agents section), not Clawforce.`,
  });
}
if (config.provider !== undefined) {
  warnings.push({
    level: "error",
    agentId,
    message: `"provider" is a runtime setting — configure it in OpenClaw's agent config, not Clawforce.`,
  });
}
```

Also add a similar check for `GlobalAgentDef` validation if there's a validator for the global config. Check the `validateDomainQuality()` function for where to add this.

- [ ] **Step 2: Write test**

Add a test to the existing config validation test file (`test/config/suggestions.test.ts` or similar):

```typescript
it("rejects model field with migration message", () => {
  // Create a config with model set and verify it produces an error-level warning
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run test/config/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/config-validator.ts test/config/
git commit -m "feat(thinning): reject model/provider in Clawforce config with migration message"
```

---

## Chunk 2: Plumbing Delegation

### Task 4: Memory Flush Thinning

Delete turn counting from flush-tracker.ts. Keep the flush prompt generation. The prompt is per-agent based on CompactionConfig.files.

**Files:**
- Modify: `src/memory/flush-tracker.ts`
- Modify: `adapters/openclaw.ts` (remove turn counting calls)
- Test: update `test/memory/flush-tracker.test.ts` if it exists

- [ ] **Step 1: Identify turn counting vs prompt code**

In `src/memory/flush-tracker.ts` (158 lines):
- **Delete**: `SessionState` type, `sessions` Map, `getOrCreate()`, `incrementTurnCount()`, `getTurnCount()`, `incrementToolCallCount()`, `shouldFlush()`, `markMemoryWrite()`, `hasMemoryWrite()`, `markFlushAttempted()`, `hasFlushBeenAttempted()`, `resetCycle()`, `clearSession()`, `clearAllSessions()`, `isSessionSubstantive()` — all the turn/state tracking
- **Keep**: `FLUSH_PROMPT` constant, `getFlushPrompt()` function, and `isMemoryWriteCall()` (used by adapter's after_tool_call handler to detect memory writes — this is useful beyond turn counting)
- **Keep the original FLUSH_PROMPT text** — do not change the prompt wording, only add the optional `fileTargets` parameter

- [ ] **Step 2: Strip flush-tracker.ts to prompt-only**

Rewrite `src/memory/flush-tracker.ts` to contain only the prompt generation:

```typescript
/**
 * Clawforce — Flush Prompt Generation
 *
 * Per-agent flush prompts for memory checkpoint turns.
 * Timing delegated to OpenClaw's native memoryFlush (softThresholdTokens).
 * This module only generates the prompt content.
 */

const FLUSH_PROMPT = `## Memory Checkpoint

Take a moment to save important context from this session to memory.

Review your recent work and identify:
- Key decisions made and their rationale
- Important findings or learnings
- Context that would be valuable in future sessions

Use memory_search to check for existing related memories before saving to avoid duplicates.`;

export function getFlushPrompt(fileTargets?: string[]): string {
  if (!fileTargets || fileTargets.length === 0) return FLUSH_PROMPT;

  const fileSection = fileTargets
    .map((f) => `- ${f}`)
    .join("\n");

  return `${FLUSH_PROMPT}\n\nAlso update these files with relevant learnings:\n${fileSection}`;
}
```

- [ ] **Step 3: Update adapters/openclaw.ts**

Find all calls to the deleted functions in `adapters/openclaw.ts` and remove them. The adapter imports ~12 functions from flush-tracker at lines 82-85. After thinning, only keep imports for `getFlushPrompt` and `isMemoryWriteCall`.

Specific adapter locations to clean up:
- `before_prompt_build` handler: remove `incrementTurnCount` call (~line 339)
- `after_tool_call` handler: remove `incrementToolCallCount`, `markMemoryWrite` calls (~lines 492-496). Keep the `isMemoryWriteCall` check if it's used for other purposes.
- `agent_end` handler: remove the entire flush timing block that calls `shouldFlush`, `markFlushAttempted`, `resetCycle` (~lines 641-681). Keep the `getFlushPrompt()` call and the `injectAgentMessage` for per-agent flush — but it should now be triggered by a different mechanism (not turn counting).

Keep any call to `getFlushPrompt()` and `isMemoryWriteCall()` — those are the parts we're keeping.

- [ ] **Step 4: Update imports**

In `adapters/openclaw.ts`, update the import from `flush-tracker.js` to only import `getFlushPrompt`.

In `src/index.ts`, update exports from `flush-tracker.js` to only export `getFlushPrompt`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run`

Fix any test that references deleted functions. If `test/memory/flush-tracker.test.ts` exists, strip it to only test `getFlushPrompt()`.

- [ ] **Step 6: Commit**

```bash
git add src/memory/flush-tracker.ts adapters/openclaw.ts src/index.ts
git commit -m "refactor(thinning): strip turn counting from flush-tracker, keep prompt generation"
```

---

### Task 5: Cron Types Cleanup

Delete Clawforce's CronJobRecord, CronServiceLike, and CronJobState type redefinitions. Import from OpenClaw's plugin-sdk.

**Files:**
- Modify: `src/manager-cron.ts:45-75`
- Modify: `adapters/openclaw.ts:221`
- Modify: `src/index.ts`

- [ ] **Step 1: Check OpenClaw's exported cron types**

Run: `grep -r "CronJob" node_modules/.pnpm/openclaw@*/node_modules/openclaw/dist/plugin-sdk/index.d.ts | head -20`

Identify the exact type names OpenClaw exports. They may be `CronJob`, `CronJobRecord`, or similar. If exact matches don't exist, create thin type aliases.

- [ ] **Step 2: Replace type definitions in manager-cron.ts**

In `src/manager-cron.ts`, delete the `CronJobRecord`, `CronServiceLike`, and `CronJobState` type definitions (lines 45-75). Replace with imports from OpenClaw:

```typescript
// If OpenClaw exports compatible types:
import type { CronJobRecord, CronServiceLike } from "openclaw/plugin-sdk";

// If OpenClaw's types have different names, create aliases:
// import type { SomeOpenClawCronType as CronJobRecord } from "openclaw/plugin-sdk";
```

If OpenClaw doesn't export directly compatible types, keep thin wrapper types that reference the OpenClaw originals.

- [ ] **Step 3: Remove inline CronServiceLike from adapters/openclaw.ts**

Delete the inline type definition at line 221 of `adapters/openclaw.ts`. Use the import from `manager-cron.ts` instead (which now re-exports from OpenClaw).

- [ ] **Step 4: Update index.ts exports**

If `CronServiceLike` was re-exported from `src/index.ts`, update the export to reflect the new source.

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: PASS — type changes only, no runtime behavior change

- [ ] **Step 6: Commit**

```bash
git add src/manager-cron.ts adapters/openclaw.ts src/index.ts
git commit -m "refactor(thinning): import cron types from OpenClaw instead of redefining"
```

---

### Task 6: Channel Delivery Adapter

Replace the three setter-pattern notifiers with a unified channel delivery adapter.

**Files:**
- Create: `src/channels/deliver.ts`
- Modify: `src/approval/notify.ts`
- Modify: `src/messaging/notify.ts`
- Modify: `src/channels/notify.ts` (if exists)
- Modify: `adapters/openclaw.ts`
- Test: `test/channels/deliver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/channels/deliver.test.ts`:

```typescript
import { afterEach, describe, expect, it } from "vitest";

describe("channel delivery", () => {
  afterEach(async () => {
    const { clearDeliveryAdapter } = await import("../../src/channels/deliver.js");
    clearDeliveryAdapter();
  });

  it("delivers to log when no adapter set", async () => {
    const { deliverMessage } = await import("../../src/channels/deliver.js");
    const result = await deliverMessage({
      channel: "telegram",
      content: "test message",
      target: { chatId: "123" },
    });
    // Falls back to logging, doesn't throw
    expect(result.delivered).toBe(false);
    expect(result.fallback).toBe("log");
  });

  it("delivers via adapter when set", async () => {
    const { setDeliveryAdapter, deliverMessage } = await import("../../src/channels/deliver.js");

    let captured: unknown = null;
    setDeliveryAdapter({
      send: async (channel, content, target) => {
        captured = { channel, content, target };
        return { sent: true };
      },
    });

    const result = await deliverMessage({
      channel: "telegram",
      content: "test",
      target: { chatId: "456" },
    });

    expect(result.delivered).toBe(true);
    expect(captured).toEqual({
      channel: "telegram",
      content: "test",
      target: { chatId: "456" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/channels/deliver.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the delivery adapter**

Create `src/channels/deliver.ts`:

```typescript
/**
 * Clawforce — Unified Channel Delivery
 *
 * Thin adapter for delivering messages to any channel via OpenClaw's runtime.channel.* APIs.
 * Replaces the three setter-pattern notifiers (approval, messaging, channel).
 */

import { safeLog } from "../diagnostics.js";

export type DeliveryAdapter = {
  send(
    channel: string,
    content: string,
    target: Record<string, unknown>,
    options?: { buttons?: unknown[]; format?: string },
  ): Promise<{ sent: boolean; messageId?: string; error?: string }>;

  edit?(
    channel: string,
    messageId: string,
    content: string,
    target: Record<string, unknown>,
  ): Promise<{ sent: boolean; error?: string }>;
};

export type DeliveryRequest = {
  channel: string;
  content: string;
  target: Record<string, unknown>;
  options?: { buttons?: unknown[]; format?: string };
};

export type DeliveryResult = {
  delivered: boolean;
  messageId?: string;
  error?: string;
  fallback?: string;
};

let adapter: DeliveryAdapter | null = null;

export function setDeliveryAdapter(a: DeliveryAdapter | null): void {
  adapter = a;
}

export function getDeliveryAdapter(): DeliveryAdapter | null {
  return adapter;
}

export function clearDeliveryAdapter(): void {
  adapter = null;
}

export async function deliverMessage(req: DeliveryRequest): Promise<DeliveryResult> {
  if (!adapter) {
    safeLog("deliver", `No delivery adapter set — logging message for channel "${req.channel}": ${req.content.slice(0, 100)}`);
    return { delivered: false, fallback: "log" };
  }

  try {
    const result = await adapter.send(req.channel, req.content, req.target, req.options);
    return {
      delivered: result.sent,
      messageId: result.messageId,
      error: result.error,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    safeLog("deliver", `Delivery failed for channel "${req.channel}": ${error}`);
    return { delivered: false, error };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/channels/deliver.test.ts`
Expected: PASS

- [ ] **Step 5: Wire delivery adapter in adapters/openclaw.ts**

In the `gateway_start` handler where the existing notifiers are set up, create and set the delivery adapter using OpenClaw's channel APIs:

```typescript
import { setDeliveryAdapter } from "../src/channels/deliver.js";

// In gateway_start handler:
// Capture the channel APIs from the gateway context (same pattern as existing code)
const channelApis = context.channelApis; // or however the adapter currently captures sendTelegram

setDeliveryAdapter({
  send: async (channel, content, target, options) => {
    switch (channel) {
      case "telegram": {
        // Match the actual call signature used in the adapter (~line 1200):
        // sendTelegram(target, message, { textMode, buttons, messageThreadId })
        const sendTelegram = channelApis?.telegram?.sendMessageTelegram;
        if (!sendTelegram) return { sent: false, error: "Telegram not configured" };
        const result = await sendTelegram(
          String(target.chatId ?? ""),
          content,
          {
            textMode: "markdown",
            ...(options?.buttons ? { buttons: options.buttons } : {}),
            ...(target.threadId ? { messageThreadId: Number(target.threadId) } : {}),
          },
        );
        return { sent: !!result, messageId: result?.messageId };
      }
      // Add other channels as needed (slack, discord, etc.)
      default:
        return { sent: false, error: `Unsupported channel: ${channel}` };
    }
  },
  edit: async (channel, messageId, content, target) => {
    // Edit support for approval resolution messages
    // Implementation depends on channel-specific edit APIs
    // For now, log and return success (edit is best-effort)
    safeLog("deliver", `Edit message ${messageId} on ${channel}: ${content.slice(0, 50)}`);
    return { sent: true };
  },
});
```

- [ ] **Step 6: Migrate existing notifiers to use deliverMessage()**

Update `src/approval/notify.ts`, `src/messaging/notify.ts`, and `src/channels/notify.ts` to use `deliverMessage()` internally instead of their own setter patterns. Keep the existing function signatures as thin wrappers so callers don't need to change.

For example, in `src/approval/notify.ts`:

```typescript
import { deliverMessage } from "../channels/deliver.js";

export async function sendProposalNotification(payload: NotificationPayload): Promise<NotificationResult> {
  const content = formatTelegramMessage(payload);
  const channel = resolveApprovalChannel(payload.projectId, payload.proposedBy);

  const result = await deliverMessage({
    channel: channel.type,
    content,
    target: { chatId: channel.chatId },
    options: { buttons: buildApprovalButtons(payload.projectId, payload.proposalId) },
  });

  return {
    sent: result.delivered,
    channel: channel.type as ApprovalChannel,
    messageId: result.messageId,
    error: result.error,
  };
}
```

- [ ] **Step 7: Remove old setter calls from adapters/openclaw.ts**

Remove `setApprovalNotifier()`, `setMessageNotifier()`, `setChannelNotifier()` calls from the adapter. These are replaced by the single `setDeliveryAdapter()` call.

- [ ] **Step 8: Run full tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/channels/deliver.ts src/approval/notify.ts src/messaging/notify.ts adapters/openclaw.ts test/channels/deliver.test.ts
git commit -m "refactor(thinning): unified channel delivery adapter replacing three setter patterns"
```

---

## Chunk 3: Cost + Exports + Final

### Task 7: Cost Data — Primary Path via OpenClaw

Add `loadSessionCostSummary()` as primary cost data source. Fall back to existing `llm_output` + `pricing.ts` path.

**Files:**
- Modify: `src/cost.ts`
- Modify: `adapters/openclaw.ts` (agent_end handler)
- Test: `test/cost.test.ts`

- [ ] **Step 1: Verify loadSessionCostSummary accessibility**

Run: `grep -r "loadSessionCostSummary\|loadCostUsageSummary" node_modules/.pnpm/openclaw@*/node_modules/openclaw/dist/plugin-sdk/index.d.ts`

If the function is exported from the plugin-sdk, proceed. If NOT exported, **skip this task entirely** — the existing `llm_output` + `pricing.ts` path remains. Document the finding and move on.

- [ ] **Step 2: Add OpenClaw cost reading function**

If accessible, add to `src/cost.ts`:

```typescript
import { safeLog } from "./diagnostics.js";

/**
 * Try to read session cost from OpenClaw's cost API.
 * Returns cost in cents, or null if unavailable.
 */
export async function readCostFromOpenClaw(
  sessionKey: string,
  loadSessionCostSummary: ((params: { sessionKey: string }) => Promise<unknown>) | null,
): Promise<number | null> {
  if (!loadSessionCostSummary) return null;

  try {
    const summary = await loadSessionCostSummary({ sessionKey }) as {
      totalCostCents?: number;
      [key: string]: unknown;
    } | null;

    if (summary?.totalCostCents != null) {
      return Math.round(summary.totalCostCents);
    }
    return null;
  } catch (err) {
    safeLog("cost", `Failed to read cost from OpenClaw: ${err}`);
    return null;
  }
}
```

- [ ] **Step 3: Integrate into agent_end handler**

In `adapters/openclaw.ts`, in the `agent_end` hook handler, after compliance checking and before the existing cost recording:

```typescript
// Try OpenClaw cost API first
const openclawCost = await readCostFromOpenClaw(sessionKey, api.runtime?.loadSessionCostSummary ?? null);
if (openclawCost !== null) {
  // Record using OpenClaw's authoritative cost
  recordCostDirect({ projectId, agentId, sessionKey, costCents: openclawCost });
} else {
  // Fallback: existing llm_output-based recording continues to work
}
```

- [ ] **Step 4: Add recordCostDirect helper**

Add to `src/cost.ts` a simpler recording function that takes pre-computed cost:

```typescript
export function recordCostDirect(params: {
  projectId: string;
  agentId: string;
  sessionKey?: string;
  taskId?: string;
  costCents: number;
  model?: string;
}, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(params.projectId);
  const id = crypto.randomUUID();
  const now = Date.now();

  // IMPORTANT: Check the actual cost_records schema (migration V4) before writing.
  // The table may have NOT NULL columns (input_tokens, output_tokens, etc.) that need defaults.
  // Use the EXISTING recordCost() function as reference for the correct INSERT statement.
  // If cost_records requires token columns, pass 0 for them when recording from OpenClaw's
  // pre-computed cost (we only have the total, not the breakdown).
  //
  // Pattern: copy the INSERT from the existing recordCost() and set token columns to 0.
  db.prepare(`
    INSERT INTO cost_records (id, project_id, agent_id, session_key, task_id, cost_cents,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      model, provider, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, NULL, 'openclaw', ?)
  `).run(id, params.projectId, params.agentId, params.sessionKey ?? null,
    params.taskId ?? null, params.costCents, params.model ?? null, now);

  // Update daily spend counters
  db.prepare(`
    UPDATE budgets SET daily_spent_cents = daily_spent_cents + ?
    WHERE project_id = ? AND (agent_id = ? OR agent_id IS NULL)
  `).run(params.costCents, params.projectId, params.agentId);
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/cost.test.ts`
Expected: PASS (existing tests still work — fallback path unchanged)

- [ ] **Step 6: Commit**

```bash
git add src/cost.ts adapters/openclaw.ts
git commit -m "feat(thinning): add OpenClaw cost API as primary cost source with fallback"
```

---

### Task 8: Update Exports and Final Integration

Update `src/index.ts` with new exports, clean up old ones.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add new exports**

```typescript
// --- Config: OpenClaw Reader ---
export { setOpenClawConfig, getAgentModel, getAgentTools, getModelPricing, getProviderRateLimits, clearOpenClawConfigCache } from "./config/openclaw-reader.js";

// --- Channel Delivery ---
export { setDeliveryAdapter, getDeliveryAdapter, deliverMessage, clearDeliveryAdapter } from "./channels/deliver.js";
export type { DeliveryAdapter, DeliveryRequest, DeliveryResult } from "./channels/deliver.js";
```

- [ ] **Step 2: Update flush-tracker exports**

Replace old flush-tracker exports with just `getFlushPrompt`:

```typescript
export { getFlushPrompt } from "./memory/flush-tracker.js";
```

Remove any exports of deleted functions (incrementTurnCount, shouldFlush, etc.).

- [ ] **Step 3: Remove model from AgentConfig re-export**

If `AgentConfig` is re-exported as a type, the type change is automatic. Verify no explicit model-related type exports need cleanup.

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 5: Run TypeScript compilation check**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "refactor(thinning): update exports for thinned architecture"
```

---

### Task 9: Update ROADMAP

**Files:**
- Modify: `ROADMAP-v2.md`

- [ ] **Step 1: Add thinning initiative to roadmap**

Add a new section after Phase 10 or as an architectural milestone:

```markdown
### OpenClaw Thinning (Architectural)
- [x] Strip runtime config (model/provider) from Clawforce types
- [x] OpenClaw config reader for runtime data lookups
- [x] Delegate memory flush timing to OpenClaw native memoryFlush
- [x] Import cron types from OpenClaw (delete redefinitions)
- [x] Unified channel delivery adapter (replace 3 setter patterns)
- [x] Cost data: OpenClaw API primary, llm_output fallback
- [x] Config validation rejects runtime fields with migration message
```

- [ ] **Step 2: Run final test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add ROADMAP-v2.md
git commit -m "docs: update roadmap with OpenClaw thinning initiative"
```
