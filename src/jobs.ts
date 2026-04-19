/**
 * Clawforce — Scoped session (job) resolution
 *
 * Parses the job tag from a cron prompt and computes
 * the effective AgentConfig for a job-scoped session.
 */

import type { AgentConfig, ContextSource, JobDefinition } from "./types.js";
import { getAgentConfig } from "./project.js";
import { getDirectReports } from "./org.js";

/** Pattern for job tags embedded in cron payloads. */
const JOB_TAG_RE = /\[clawforce:job=([^\]]+)\]/;

/** Pattern for dispatch tags embedded in cron payloads. */
const DISPATCH_TAG_RE = /\[clawforce:dispatch=([^:]+):([^\]]+)\]/;

/**
 * Extract dispatch context from a cron prompt message.
 * Returns null if no dispatch tag is found.
 */
export function resolveDispatchContext(prompt: string | undefined): { queueItemId: string; taskId: string } | null {
  if (!prompt) return null;
  const match = prompt.match(DISPATCH_TAG_RE);
  return match ? { queueItemId: match[1]!.trim(), taskId: match[2]!.trim() } : null;
}

/**
 * Extract the job name from a cron prompt message.
 * Returns null if no job tag is found.
 */
export function resolveJobName(prompt: string | undefined): string | null {
  if (!prompt) return null;
  const match = prompt.match(JOB_TAG_RE);
  return match ? match[1]!.trim() : null;
}

/**
 * Compute the effective AgentConfig for a job-scoped session.
 *
 * Resolution rules:
 * - briefing: job replaces if specified, else base minus exclude_briefing
 * - expectations, performance_policy, compaction: job replaces if specified, else inherit base
 * - "instructions" source auto-prepended if missing from effective briefing
 * - Base identity fields (extends, title, persona, etc.) are preserved
 *
 * Returns null if the job name is not found in the agent's jobs map.
 */
export function resolveEffectiveConfig(
  base: AgentConfig,
  jobName: string,
): AgentConfig | null {
  const job = base.jobs?.[jobName];
  if (!job) return null;

  const briefing = resolveJobBriefing(base, job);
  const expectations = job.expectations ?? base.expectations;
  const performance_policy = job.performance_policy ?? base.performance_policy;
  const compaction = job.compaction !== undefined ? job.compaction : base.compaction;

  // Tool scoping: job.tools narrows the agent's available tools
  const tools = job.tools && base.tools
    ? base.tools.filter(t => job.tools!.includes(t))
    : job.tools ?? base.tools;

  return {
    ...base,
    briefing,
    expectations,
    performance_policy,
    compaction,
    tools,
    // Don't propagate jobs into the effective config
    jobs: undefined,
  };
}

// --- Job management helpers (runtime CRUD) ---

/**
 * Check if callerAgent can manage targetAgent's jobs.
 * Self-management is always allowed. Managers can manage their direct reports.
 */
export function canManageJobs(projectId: string, callerAgentId: string, targetAgentId: string): boolean {
  if (callerAgentId === targetAgentId) return true;

  const callerEntry = getAgentConfig(callerAgentId, projectId);
  if (!callerEntry || callerEntry.projectId !== projectId) return false;
  if (!callerEntry.config.coordination?.enabled) return false;

  const reports = getDirectReports(projectId, callerAgentId);
  return reports.includes(targetAgentId);
}

/**
 * List all jobs defined on an agent.
 * Returns empty record if agent has no jobs, null if agent not found.
 */
export function listJobs(agentId: string, projectId?: string): Record<string, JobDefinition> | null {
  const entry = getAgentConfig(agentId, projectId);
  if (!entry) return null;
  return entry.config.jobs ?? {};
}

/**
 * Add or update a job on an agent (in-memory only).
 * Returns false if agent not found.
 */
export function upsertJob(agentId: string, jobName: string, job: JobDefinition, projectId?: string): boolean {
  const entry = getAgentConfig(agentId, projectId);
  if (!entry) return false;
  if (!entry.config.jobs) entry.config.jobs = {};
  entry.config.jobs[jobName] = job;
  return true;
}

/**
 * Remove a job from an agent (in-memory only).
 * Returns false if agent or job not found.
 */
export function deleteJob(agentId: string, jobName: string, projectId?: string): boolean {
  const entry = getAgentConfig(agentId, projectId);
  if (!entry) return false;
  if (!entry.config.jobs || !entry.config.jobs[jobName]) return false;
  delete entry.config.jobs[jobName];
  if (Object.keys(entry.config.jobs).length === 0) {
    entry.config.jobs = undefined;
  }
  return true;
}

/**
 * Resolve the effective briefing for a job.
 */
function resolveJobBriefing(base: AgentConfig, job: JobDefinition): ContextSource[] {
  let briefing: ContextSource[];

  if (job.briefing && job.briefing.length > 0) {
    // Job specifies its own briefing — use it directly
    briefing = [...job.briefing];
  } else if (job.exclude_briefing && job.exclude_briefing.length > 0) {
    // Job only excludes from base
    const excludeSet = new Set(job.exclude_briefing);
    briefing = base.briefing.filter((s) => !excludeSet.has(s.source));
  } else {
    // Inherit base briefing
    briefing = [...base.briefing];
  }

  // Always ensure "instructions" is present
  if (!briefing.some((s) => s.source === "instructions")) {
    briefing.unshift({ source: "instructions" });
  }

  return briefing;
}
