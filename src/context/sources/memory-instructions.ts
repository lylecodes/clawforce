/**
 * Clawforce — Memory Instructions Source
 *
 * Role-based memory protocol instructions.
 * Tells agents how to use OpenClaw's memory tools correctly.
 */

import type { MemoryGovernanceConfig } from "../../types.js";

export const MANAGER_MEMORY_INSTRUCTIONS = `## Memory Protocol

- Search memory at the START of every coordination cycle for relevant strategic context
- Before making decisions, check if similar situations have been handled before
- Write strategic decisions, rationale, and observations to memory using memory tools
- IMPORTANT: Save memories to the persistent RAG store using the appropriate memory write tools. Do NOT write to memory.md — that file gets truncated on compaction. The persistent memory store is accessed via memory tools.
- Your memory review job will extract learnings from your reports' sessions — review promotion candidates in your briefing`;

export const EMPLOYEE_MEMORY_INSTRUCTIONS = `## Memory Protocol

- Your knowledge comes through skills and curated context — check your skill documentation first
- If you discover something reusable during your task, write it to memory using memory tools (NOT memory.md)
- memory.md gets truncated on compaction. Use the memory tools for persistent storage.
- Your learnings will be automatically extracted and reviewed by your manager`;

const MANAGER_PRESETS = new Set(["manager"]);

/**
 * Resolve memory instructions content for an agent.
 *
 * @param memoryConfig — the agent's memory governance config (may be undefined)
 * @param extendsFrom — the preset the agent extends ("manager", "employee", "assistant", etc.)
 * @returns markdown string to inject, or null if disabled
 */
export function resolveMemoryInstructions(
  memoryConfig: MemoryGovernanceConfig | undefined,
  extendsFrom: string,
): string | null {
  const instructions = memoryConfig?.instructions;

  // Explicitly disabled
  if (instructions === false) return null;

  // Custom string
  if (typeof instructions === "string") {
    return `## Memory Protocol\n\n${instructions}`;
  }

  // true or undefined → use role default
  if (MANAGER_PRESETS.has(extendsFrom)) {
    return MANAGER_MEMORY_INSTRUCTIONS;
  }
  return EMPLOYEE_MEMORY_INSTRUCTIONS;
}
