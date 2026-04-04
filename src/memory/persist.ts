/**
 * Clawforce — Memory Persist Rules
 *
 * Handles memory persistence rules: determines when and what to save
 * to long-term memory based on agent configuration.
 */

import type {
  MemoryGovernanceConfig,
  MemoryPersistTrigger,
  MemoryPersistAction,
  MemoryPersistRule,
  AgentConfig,
} from "../types.js";

// ── Built-in extraction prompts ──

const BUILTIN_PROMPTS: Record<Exclude<MemoryPersistAction, "custom">, string> = {
  extract_learnings:
    "Review this session. Extract key learnings, patterns, and reusable knowledge. Write to memory.",
  save_decisions:
    "Extract decisions made in this session with reasoning. Write to memory.",
  save_errors:
    "Extract errors, failures, and what was learned from them. Write to memory.",
};

// ── Default persist rules ──

const DEFAULT_PERSIST_RULES: MemoryPersistRule[] = [
  { trigger: "session_end", action: "extract_learnings" },
];

// ── Public API ──

/**
 * Check if any persist rule matches the given trigger for this agent.
 * Returns matching rules, or empty array if none match (or persistence is disabled).
 */
export function shouldPersistMemory(
  trigger: MemoryPersistTrigger,
  agentConfig: AgentConfig,
): MemoryPersistRule[] {
  const persist = agentConfig.memory?.persist;

  // If persist is explicitly disabled, never persist
  if (persist?.enabled === false) return [];

  // Use configured rules, or defaults if autoExtract is enabled (or not configured)
  const rules = persist?.rules;
  if (rules && rules.length > 0) {
    return rules.filter((rule) => rule.trigger === trigger);
  }

  // No explicit rules — check autoExtract (default true)
  const autoExtract = persist?.autoExtract ?? true;
  if (autoExtract && trigger === "session_end") {
    return DEFAULT_PERSIST_RULES;
  }

  return [];
}

/**
 * Get the extraction prompt for a given persist rule and agent config.
 * For "custom" actions, uses the rule's prompt field.
 * For built-in actions, uses the built-in prompt.
 * The agent config's extractPrompt overrides the default for extract_learnings.
 */
export function getExtractionPrompt(
  rule: MemoryPersistRule,
  agentConfig: AgentConfig,
): string {
  if (rule.action === "custom") {
    return rule.prompt ?? "Extract relevant information from this session and write to memory.";
  }

  // For extract_learnings, allow agent-level extractPrompt override
  if (rule.action === "extract_learnings") {
    const customPrompt = agentConfig.memory?.persist?.extractPrompt;
    if (customPrompt) return customPrompt;
  }

  return BUILTIN_PROMPTS[rule.action];
}

/**
 * Get all persist rules for an agent, resolved with defaults.
 * Returns the configured rules or default rules if autoExtract is enabled.
 */
export function getEffectivePersistRules(agentConfig: AgentConfig): MemoryPersistRule[] {
  const persist = agentConfig.memory?.persist;

  if (persist?.enabled === false) return [];

  if (persist?.rules && persist.rules.length > 0) {
    return persist.rules;
  }

  const autoExtract = persist?.autoExtract ?? true;
  return autoExtract ? [...DEFAULT_PERSIST_RULES] : [];
}

/**
 * Check if the memory provider is MCP-based for this agent.
 */
export function isExternalMemoryProvider(agentConfig: AgentConfig): boolean {
  return agentConfig.memory?.provider?.type === "mcp";
}
