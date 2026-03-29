import { describe, expect, it } from "vitest";

// Side-effect import triggers all registrations
import "../../src/context/register-sources.js";
import { getRegisteredSources } from "../../src/context/registry.js";

/**
 * All source names from the ContextSource["source"] union type.
 * If you add a new source to the type, add it here and register it
 * in src/context/register-sources.ts.
 */
const ALL_SOURCE_NAMES = [
  "instructions",
  "custom",
  "project_md",
  "task_board",
  "assigned_task",
  "knowledge",
  "file",
  "skill",
  "memory",
  "memory_instructions",
  "memory_review_context",
  "escalations",
  "workflows",
  "activity",
  "sweep_status",
  "proposals",
  "agent_status",
  "cost_summary",
  "policy_status",
  "health_status",
  "team_status",
  "team_performance",
  "soul",
  "tools_reference",
  "pending_messages",
  "goal_hierarchy",
  "channel_messages",
  "planning_delta",
  "velocity",
  "preferences",
  "trust_scores",
  "resources",
  "initiative_status",
  "cost_forecast",
  "available_capacity",
  "knowledge_candidates",
  "budget_guidance",
  "onboarding_welcome",
  "weekly_digest",
  "intervention_suggestions",
  "custom_stream",
  "observed_events",
  "direction",
  "policies",
  "standards",
  "architecture",
  "task_creation_standards",
  "execution_standards",
  "review_standards",
  "rejection_standards",
  "clawforce_health_report",
] as const;

describe("context source registry", () => {
  it("has all sources registered", () => {
    const registered = new Set(getRegisteredSources());
    const missing = ALL_SOURCE_NAMES.filter((name) => !registered.has(name));
    expect(missing, `Missing registrations: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no extra sources registered beyond the known set", () => {
    const registered = getRegisteredSources();
    const known = new Set<string>(ALL_SOURCE_NAMES);
    const extra = registered.filter((name) => !known.has(name));
    expect(extra, `Unexpected registrations: ${extra.join(", ")}`).toEqual([]);
  });

  it(`registers exactly ${ALL_SOURCE_NAMES.length} sources`, () => {
    const registered = getRegisteredSources();
    expect(registered.length).toBe(ALL_SOURCE_NAMES.length);
  });
});
