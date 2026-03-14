/**
 * Clawforce — Budget Guidance Briefing Source
 *
 * Runtime budget guidance injected into manager reflection.
 * Delegates to the forecast module for daily snapshot, weekly trend,
 * and monthly projection data.
 */

import { getDb } from "../../db.js";
import { safeLog } from "../../diagnostics.js";
import {
  computeDailySnapshot,
  computeWeeklyTrend,
  computeMonthlyProjection,
} from "../../budget/forecast.js";

export function resolveBudgetGuidanceSource(
  projectId: string,
  params: Record<string, unknown> | undefined,
): string | null {
  if (!projectId) return null;

  try {
    const db = getDb(projectId);

    const snapshot = computeDailySnapshot(projectId, db);

    // No budget configured — nothing to report
    if (snapshot.cents.limit <= 0 && snapshot.tokens.limit <= 0) return null;

    const lines: string[] = ["## Budget Guidance", ""];

    // --- Daily Snapshot ---
    if (snapshot.cents.limit > 0) {
      const exhaustionNote = snapshot.exhaustionEta
        ? ` At current velocity, exhausts by ${snapshot.exhaustionEta.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`
        : "";
      lines.push(
        `Daily cost: ${snapshot.cents.utilization}% ($${(snapshot.cents.spent / 100).toFixed(2)} of $${(snapshot.cents.limit / 100).toFixed(2)}, $${(snapshot.cents.reserved / 100).toFixed(2)} reserved).${exhaustionNote}`,
      );
    }

    if (snapshot.tokens.limit > 0) {
      lines.push(
        `Daily tokens: ${snapshot.tokens.utilization}% (${fmtTokens(snapshot.tokens.spent)} of ${fmtTokens(snapshot.tokens.limit)}).`,
      );
    }

    if (snapshot.requests.limit > 0) {
      lines.push(
        `Daily requests: ${snapshot.requests.utilization}% (${snapshot.requests.spent} of ${snapshot.requests.limit}).`,
      );
    }

    if (snapshot.sessionsRemaining > 0) {
      lines.push(`Estimated sessions remaining: ~${snapshot.sessionsRemaining}.`);
    }

    // --- Weekly Trend ---
    try {
      const trend = computeWeeklyTrend(projectId, db);
      if (trend.dailyAverage.cents > 0) {
        const arrow =
          trend.direction.cents === "up"
            ? "^"
            : trend.direction.cents === "down"
              ? "v"
              : "=";
        lines.push("");
        lines.push(
          `Weekly trend: $${(trend.dailyAverage.cents / 100).toFixed(2)}/day avg (${arrow} ${Math.abs(trend.changePercent.cents)}% ${trend.direction.cents}).`,
        );
      }
    } catch {
      // non-fatal — weekly trend is optional context
    }

    // --- Monthly Projection ---
    try {
      const projection = computeMonthlyProjection(projectId, db);
      if (
        projection.monthlyLimit.cents !== null &&
        projection.projectedTotal.cents > 0
      ) {
        const pct = Math.round(
          (projection.projectedTotal.cents / projection.monthlyLimit.cents) *
            100,
        );
        lines.push(
          `Monthly projection: $${(projection.projectedTotal.cents / 100).toFixed(2)} projected of $${(projection.monthlyLimit.cents / 100).toFixed(2)} limit (${pct}%).`,
        );
        if (projection.exhaustionDay !== null) {
          lines.push(
            `Warning: projected to exhaust monthly budget by day ${projection.exhaustionDay}.`,
          );
        }
      }
    } catch {
      // non-fatal
    }

    // --- Initiative breakdown ---
    if (snapshot.initiatives.length > 0) {
      lines.push("");
      lines.push("### Initiative Breakdown");
      for (const init of snapshot.initiatives) {
        lines.push(
          `- ${init.name}: ${init.utilization}% of ${init.allocation}% allocation ($${(init.spent.cents / 100).toFixed(2)})`,
        );
      }
    }

    return lines.join("\n");
  } catch (err) {
    safeLog("budget-guidance", `Failed to generate budget guidance: ${err}`);
    return null;
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
