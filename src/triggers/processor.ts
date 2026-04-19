/**
 * Clawforce — Trigger processor
 *
 * Core logic for firing a trigger:
 *   1. Look up trigger definition from project config
 *   2. Check enabled state
 *   3. Check cooldown window
 *   4. Evaluate conditions against payload
 *   5. Render template via interpolate()
 *   6. Execute the trigger action (create task, emit event, enqueue, or none)
 *   7. Ingest a "trigger_fired" event for audit
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import type {
  TriggerDefinition,
  TriggerSource,
  TaskPriority,
  Task,
} from "../types.js";
import { getExtendedProjectConfig } from "../project.js";
import { evaluateConditions, type ConditionsResult } from "./conditions.js";
import { interpolate, type TemplateContext } from "../events/template.js";
import { createTask } from "../tasks/ops.js";
import { ingestEvent } from "../events/store.js";
import { enqueue } from "../dispatch/queue.js";
import { getDefaultRuntimeState } from "../runtime/default-runtime.js";

/** Result of a trigger fire attempt. */
export type TriggerFireResult = {
  ok: boolean;
  triggerName: string;
  reason?: string;
  /** Condition evaluation results (present when conditions were evaluated). */
  conditionsResult?: ConditionsResult;
  /** The task that was created (if action is "create_task" and conditions passed). */
  task?: Task;
  /** The event ID that was ingested for audit. */
  eventId?: string;
};

type TriggerRuntimeState = {
  cooldowns: Map<string, number>;
};

const runtime = getDefaultRuntimeState();

function getCooldowns(): TriggerRuntimeState["cooldowns"] {
  return (runtime.triggers as TriggerRuntimeState).cooldowns;
}

/** Clear all cooldowns (for testing). */
export function clearCooldowns(): void {
  getCooldowns().clear();
}

/**
 * Check if a trigger is within its cooldown window.
 * Returns true if the trigger should be suppressed.
 */
function isCoolingDown(
  projectId: string,
  triggerName: string,
  cooldownMs: number | undefined,
): boolean {
  if (!cooldownMs || cooldownMs <= 0) return false;
  const key = `${projectId}:${triggerName}`;
  const lastFire = getCooldowns().get(key);
  if (lastFire === undefined) return false;
  return Date.now() - lastFire < cooldownMs;
}

/**
 * Record a trigger fire for cooldown tracking.
 */
function recordCooldown(projectId: string, triggerName: string): void {
  const key = `${projectId}:${triggerName}`;
  getCooldowns().set(key, Date.now());
}

/**
 * Fire a trigger by name.
 *
 * @param domain      - The project/domain ID
 * @param triggerName - Name of the trigger (key in triggers config)
 * @param payload     - Arbitrary payload to evaluate conditions against and use for templates
 * @param source      - Where this trigger was fired from
 * @param dbOverride  - Optional DB override (for testing with in-memory DB)
 */
export function fireTrigger(
  domain: string,
  triggerName: string,
  payload: Record<string, unknown>,
  source: TriggerSource,
  dbOverride?: DatabaseSync,
): TriggerFireResult {
  // 1. Look up trigger definition
  const extConfig = getExtendedProjectConfig(domain);
  const triggerDef = extConfig?.triggers?.[triggerName];

  if (!triggerDef) {
    return {
      ok: false,
      triggerName,
      reason: `Trigger "${triggerName}" not found in domain "${domain}"`,
    };
  }

  // 2. Check enabled
  if (triggerDef.enabled === false) {
    return {
      ok: false,
      triggerName,
      reason: `Trigger "${triggerName}" is disabled`,
    };
  }

  // 3. Check source restriction
  if (triggerDef.sources && triggerDef.sources.length > 0 && !triggerDef.sources.includes(source)) {
    return {
      ok: false,
      triggerName,
      reason: `Source "${source}" is not allowed for trigger "${triggerName}"`,
    };
  }

  // 4. Check cooldown
  if (isCoolingDown(domain, triggerName, triggerDef.cooldownMs)) {
    return {
      ok: false,
      triggerName,
      reason: `Trigger "${triggerName}" is in cooldown`,
    };
  }

  // 5. Evaluate conditions
  const conditionsResult = evaluateConditions(triggerDef.conditions, payload);
  if (!conditionsResult.pass) {
    return {
      ok: false,
      triggerName,
      reason: "Conditions not met",
      conditionsResult,
    };
  }

  // Build template context
  const templateCtx: TemplateContext = {
    event: {
      id: "",
      type: `trigger:${triggerName}`,
      source,
      projectId: domain,
    },
    payload,
  };

  // 6. Execute the action
  const action = triggerDef.action ?? "create_task";
  let task: Task | undefined;

  switch (action) {
    case "create_task": {
      const title = triggerDef.task_template
        ? interpolate(triggerDef.task_template, templateCtx)
        : `Trigger: ${triggerName}`;
      const description = triggerDef.task_description
        ? interpolate(triggerDef.task_description, templateCtx)
        : undefined;

      task = createTask(
        {
          projectId: domain,
          title,
          description,
          priority: triggerDef.task_priority ?? "P2",
          assignedTo: triggerDef.assign_to,
          createdBy: `trigger:${triggerName}`,
          tags: triggerDef.tags,
          metadata: { triggerName, triggerSource: source, triggerPayload: payload },
        },
        dbOverride,
      );
      break;
    }

    case "emit_event": {
      // Emit a custom event with the trigger payload
      ingestEvent(
        domain,
        `trigger:${triggerName}`,
        "internal",
        { triggerName, source, ...payload },
        undefined,
        dbOverride,
      );
      break;
    }

    case "enqueue": {
      // Create a task and enqueue it
      const title = triggerDef.task_template
        ? interpolate(triggerDef.task_template, templateCtx)
        : `Trigger: ${triggerName}`;
      const description = triggerDef.task_description
        ? interpolate(triggerDef.task_description, templateCtx)
        : undefined;

      task = createTask(
        {
          projectId: domain,
          title,
          description,
          priority: triggerDef.task_priority ?? "P2",
          assignedTo: triggerDef.assign_to,
          createdBy: `trigger:${triggerName}`,
          tags: triggerDef.tags,
          metadata: { triggerName, triggerSource: source, triggerPayload: payload },
        },
        dbOverride,
      );

      enqueue(domain, task.id, undefined, undefined, dbOverride);
      break;
    }

    case "none":
      // No action — just record the event below
      break;
  }

  // 7. Ingest a "trigger_fired" audit event
  const auditResult = ingestEvent(
    domain,
    "trigger_fired",
    "internal",
    {
      triggerName,
      source,
      action,
      taskId: task?.id,
      payload,
    },
    undefined,
    dbOverride,
  );

  // Record cooldown
  recordCooldown(domain, triggerName);

  return {
    ok: true,
    triggerName,
    conditionsResult,
    task,
    eventId: auditResult.id,
  };
}

/**
 * Get all trigger definitions for a domain.
 */
export function getTriggerDefinitions(
  domain: string,
): Record<string, TriggerDefinition> {
  const extConfig = getExtendedProjectConfig(domain);
  return extConfig?.triggers ?? {};
}
