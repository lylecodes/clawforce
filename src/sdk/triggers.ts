/**
 * Clawforce SDK — Triggers Namespace
 *
 * Wraps the internal trigger processor with a clean public API.
 * Provides fire(), list(), and test() methods for external trigger management.
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import type {
  TriggerDefinition,
  TriggerSource,
  Task,
} from "../types.js";
import {
  fireTrigger,
  getTriggerDefinitions,
  type TriggerFireResult,
} from "../triggers/processor.js";
import { evaluateConditions, type ConditionsResult } from "../triggers/conditions.js";
import { getExtendedProjectConfig } from "../project.js";

/** Public trigger info returned by list(). */
export type TriggerInfo = {
  name: string;
  description?: string;
  enabled: boolean;
  action: string;
  conditions: number;
  sources?: TriggerSource[];
  severity?: string;
};

/** Result from test() — evaluates conditions without firing. */
export type TriggerTestResult = {
  triggerName: string;
  found: boolean;
  enabled: boolean;
  conditionsResult?: ConditionsResult;
  wouldFire: boolean;
};

export class TriggersNamespace {
  constructor(readonly domain: string) {}

  /**
   * Fire a trigger by name.
   *
   * Evaluates conditions, creates tasks/events as configured, and returns
   * the result. This is the primary entry point for external trigger sources.
   *
   * @param name    - Name of the trigger to fire
   * @param payload - Arbitrary payload object
   * @param opts.source - Source tag (defaults to "sdk")
   * @param opts.db     - Optional DB override for testing
   */
  fire(
    name: string,
    payload?: Record<string, unknown>,
    opts?: { source?: TriggerSource; db?: DatabaseSync },
  ): TriggerFireResult {
    return fireTrigger(
      this.domain,
      name,
      payload ?? {},
      opts?.source ?? "sdk",
      opts?.db,
    );
  }

  /**
   * List all trigger definitions for this domain.
   *
   * Returns a simplified view of each trigger suitable for display.
   */
  list(): TriggerInfo[] {
    const defs = getTriggerDefinitions(this.domain);
    return Object.entries(defs).map(([name, def]) => ({
      name,
      description: def.description,
      enabled: def.enabled !== false,
      action: def.action ?? "create_task",
      conditions: def.conditions?.length ?? 0,
      sources: def.sources,
      severity: def.severity,
    }));
  }

  /**
   * Test a trigger without actually firing it.
   *
   * Evaluates conditions against the provided payload and reports whether
   * the trigger would fire, without creating any tasks or events.
   *
   * @param name    - Name of the trigger to test
   * @param payload - Payload to test conditions against
   */
  test(name: string, payload?: Record<string, unknown>): TriggerTestResult {
    const extConfig = getExtendedProjectConfig(this.domain);
    const def = extConfig?.triggers?.[name];

    if (!def) {
      return {
        triggerName: name,
        found: false,
        enabled: false,
        wouldFire: false,
      };
    }

    const enabled = def.enabled !== false;
    const conditionsResult = evaluateConditions(def.conditions, payload ?? {});

    return {
      triggerName: name,
      found: true,
      enabled,
      conditionsResult,
      wouldFire: enabled && conditionsResult.pass,
    };
  }
}
