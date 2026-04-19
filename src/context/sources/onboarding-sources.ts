/**
 * Clawforce — Human Onboarding Briefing Sources
 *
 * Three sources for manager reflection:
 * - onboarding_welcome: first-day orientation
 * - weekly_digest: periodic performance summary
 * - intervention_suggestions: pattern-detected recommendations
 */

import type { DatabaseSync } from "../../sqlite-driver.js";
import { safeLog } from "../../diagnostics.js";

type WelcomeContext = {
  agentCount: number;
  domainName: string;
};

// --- Welcome ---

export function resolveWelcomeSource(
  projectId: string,
  db: DatabaseSync,
  ctx: WelcomeContext,
): string | null {
  try {
    const delivered = db.prepare(
      `SELECT value FROM onboarding_state WHERE project_id = ? AND key = 'welcome_delivered'`,
    ).get(projectId) as { value: string } | undefined;

    if (delivered) return null;

    // Mark as delivered
    db.prepare(`
      INSERT OR REPLACE INTO onboarding_state (project_id, key, value, updated_at)
      VALUES (?, 'welcome_delivered', 'true', ?)
    `).run(projectId, Date.now());

    return [
      "## Welcome — First Coordination Cycle",
      "",
      `Domain "${ctx.domainName}" is now active with ${ctx.agentCount} agents.`,
      "",
      "First-cycle checklist:",
      "- [ ] Verify agent configs are correct (roles, tools, skills)",
      "- [ ] Run a test task to confirm dispatch works",
      "- [ ] Confirm channel routing (Telegram/Slack) is delivering messages",
      "- [ ] Review budget allocation across agents",
      "",
      "Communicate status to the human via your configured channel.",
    ].join("\n");
  } catch (err) {
    safeLog("onboarding", `Welcome source error: ${err}`);
    return null;
  }
}

// --- Weekly Digest ---

export function resolveWeeklyDigestSource(
  projectId: string,
  db: DatabaseSync,
): string | null {
  try {
    const lastDigest = db.prepare(
      `SELECT value FROM onboarding_state WHERE project_id = ? AND key = 'last_digest_at'`,
    ).get(projectId) as { value: string } | undefined;

    const lastDigestAt = lastDigest ? Number(lastDigest.value) : 0;
    const oneWeekMs = 7 * 24 * 3600 * 1000;
    const now = Date.now();

    if (lastDigestAt > 0 && now - lastDigestAt < oneWeekMs) {
      return null; // Not time yet
    }

    const periodStart = lastDigestAt || now - oneWeekMs;

    // Aggregate task stats
    const taskStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN state = 'DONE' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN state = 'FAILED' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN state = 'BLOCKED' THEN 1 ELSE 0 END) as blocked
      FROM tasks WHERE project_id = ? AND updated_at >= ?
    `).get(projectId, periodStart) as {
      total: number; completed: number; failed: number; blocked: number;
    } | undefined;

    // Aggregate cost (column is cost_cents, not total_cost_cents)
    const costStats = db.prepare(`
      SELECT COALESCE(SUM(cost_cents), 0) as total_spend
      FROM cost_records WHERE project_id = ? AND created_at >= ?
    `).get(projectId, periodStart) as { total_spend: number } | undefined;

    // Update last digest timestamp
    db.prepare(`
      INSERT OR REPLACE INTO onboarding_state (project_id, key, value, updated_at)
      VALUES (?, 'last_digest_at', ?, ?)
    `).run(projectId, String(now), now);

    const isFirstWeek = lastDigestAt === 0;
    const header = isFirstWeek ? "## Week 1 Summary" : "## Weekly Digest";

    const lines = [
      header,
      "",
      `**Tasks:** ${taskStats?.completed ?? 0} completed, ${taskStats?.failed ?? 0} failed, ${taskStats?.blocked ?? 0} blocked (${taskStats?.total ?? 0} total)`,
      `**Cost:** $${((costStats?.total_spend ?? 0) / 100).toFixed(2)}`,
    ];

    if (isFirstWeek) {
      lines.push(
        "",
        "**First-week tips:**",
        "- Consider adding skills to agents that struggled with tasks",
        "- Agents with no completions may need task reassignment or config adjustment",
        "- Review the cost breakdown per agent to optimize model choices",
      );
    }

    lines.push("", "Summarize this digest and share with the human via your configured channel.");

    return lines.join("\n");
  } catch (err) {
    safeLog("onboarding", `Weekly digest error: ${err}`);
    return null;
  }
}

// --- Intervention Suggestions ---

export function resolveInterventionSource(
  projectId: string,
  db: DatabaseSync,
  agentIds: string[],
): string | null {
  try {
    const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const suggestions: string[] = [];

    // Check dismissed interventions
    const dismissedRow = db.prepare(
      `SELECT value FROM onboarding_state WHERE project_id = ? AND key = 'dismissed_interventions'`,
    ).get(projectId) as { value: string } | undefined;
    const dismissed = new Set<string>(
      dismissedRow ? JSON.parse(dismissedRow.value) : [],
    );

    for (const agentId of agentIds) {
      // Pattern 1: Idle agent — no task completions in 48h
      if (!dismissed.has(`idle:${agentId}`)) {
        const recent = db.prepare(`
          SELECT COUNT(*) as count FROM tasks
          WHERE project_id = ? AND assigned_to = ? AND state = 'DONE'
            AND updated_at >= ?
        `).get(projectId, agentId, Date.now() - 48 * 3600 * 1000) as { count: number };

        const assigned = db.prepare(`
          SELECT COUNT(*) as count FROM tasks
          WHERE project_id = ? AND assigned_to = ? AND state IN ('ASSIGNED', 'IN_PROGRESS')
        `).get(projectId, agentId) as { count: number };

        if (recent.count === 0 && assigned.count > 0) {
          suggestions.push(
            `- **${agentId} is idle**: has ${assigned.count} assigned task(s) but no completions in 48h. Options: reassign tasks, add skills, or check for blockers. (dismiss: idle:${agentId})`,
          );
        }
      }

      // Pattern 2: Repeated failure
      if (!dismissed.has(`failure:${agentId}`)) {
        const failures = db.prepare(`
          SELECT COUNT(*) as count FROM audit_runs
          WHERE project_id = ? AND agent_id = ? AND status = 'failed'
            AND ended_at >= ?
        `).get(projectId, agentId, sevenDaysAgo) as { count: number };

        if (failures.count >= 3) {
          suggestions.push(
            `- **${agentId} has ${failures.count} failures** in the past 7 days. Options: add relevant skills, split responsibilities, or downgrade task complexity. (dismiss: failure:${agentId})`,
          );
        }
      }
    }

    if (suggestions.length === 0) return null;

    return [
      "## Intervention Suggestions",
      "",
      ...suggestions,
      "",
      "Use `clawforce_ops dismiss_intervention` with the dismiss key to stop seeing a suggestion.",
    ].join("\n");
  } catch (err) {
    safeLog("onboarding", `Intervention source error: ${err}`);
    return null;
  }
}
