/**
 * Clawforce SDK — Monitoring Namespace
 *
 * Wraps internal SLO evaluation, alert evaluation, and metrics queries
 * with a clean public API. The `domain` property maps to the internal
 * `projectId` param.
 */

import { querySlos, queryAlerts, queryHealth as internalQueryHealth } from "../dashboard/queries.js";
import { queryMetrics } from "../metrics.js";

import type { SloResult, HealthStatus } from "./types.js";

export class MonitoringNamespace {
  constructor(readonly domain: string) {}

  /**
   * Compute overall health status for the domain.
   *
   * Evaluates all configured SLOs and alert rules, then determines the
   * health tier:
   *   - RED    if 50%+ SLO breaches OR 3+ alerts fired
   *   - YELLOW if any breach, alert fired, or anomaly detected
   *   - GREEN  otherwise
   */
  health(): HealthStatus {
    try {
      const result = internalQueryHealth(this.domain);
      return {
        tier: result.tier as HealthStatus["tier"],
        sloChecked: result.sloChecked,
        sloBreach: result.sloBreach,
        alertsFired: result.alertsFired,
      };
    } catch {
      // No config or no DB — return GREEN with zeroes
      return { tier: "GREEN", sloChecked: 0, sloBreach: 0, alertsFired: 0 };
    }
  }

  /**
   * Evaluate all configured SLOs and return their individual results.
   *
   * Returns an empty array when no SLOs are configured or the domain has
   * no extended config registered.
   */
  slos(): SloResult[] {
    try {
      const { slos } = querySlos(this.domain);
      return slos.map((s) => ({
        name: s.sloName,
        actual: s.actual ?? null,
        threshold: s.threshold,
        passed: s.passed,
        noData: s.noData ?? false,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Evaluate all configured alert rules and return their fired/not-fired status.
   *
   * Returns an empty array when no alert rules are configured.
   */
  alerts(): any[] {
    try {
      const { alerts } = queryAlerts(this.domain);
      return alerts;
    } catch {
      return [];
    }
  }

  /**
   * Query recorded metrics for the domain, optionally filtered by key.
   *
   * Accepts an optional filters object:
   *   - key    — filter by metric key
   *   - since  — Unix timestamp ms (inclusive lower bound)
   *   - until  — Unix timestamp ms (inclusive upper bound)
   *   - limit  — max number of records to return (default 1000)
   */
  metrics(key?: string, filters?: { since?: number; until?: number; limit?: number }): any[] {
    try {
      return queryMetrics({
        projectId: this.domain,
        key,
        since: filters?.since,
        until: filters?.until,
        limit: filters?.limit,
      });
    } catch {
      return [];
    }
  }
}
