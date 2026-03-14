/**
 * Ghost Turn Memory Recall
 *
 * Before each agent turn, a lightweight LLM call analyses recent messages
 * and decides whether long-term memory should be searched. Results are
 * injected into the agent's context via prependContext.
 */

import { emitDiagnosticEvent } from "../diagnostics.js";
import { callTriage, resolveProvider } from "./llm-client.js";
import type { ProviderInfo, TriageResult } from "./llm-client.js";
import type { Expectation } from "../types.js";

// ── Types ──

export type GhostTurnIntensity = "low" | "medium" | "high";

export type GhostTurnOpts = {
  sessionKey: string;
  intensity: GhostTurnIntensity;
  memoryMode: boolean;
  windowSize: number;
  maxInjectedChars: number;
  maxSearches: number;
  debug: boolean;
  provider?: ProviderInfo;
  model?: string;
};

export type MemoryToolInstance = {
  execute: (callId: string, params: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
};

// ── Intensity presets ──

export const INTENSITY_PRESETS: Record<GhostTurnIntensity, { cooldownMs: number; maxSearches: number }> = {
  low: { cooldownMs: 90_000, maxSearches: 2 },
  medium: { cooldownMs: 30_000, maxSearches: 3 },
  high: { cooldownMs: 10_000, maxSearches: 4 },
};

// ── Cooldown tracking ──

const cooldowns = new Map<string, number>();

export function updateCooldown(sessionKey: string): void {
  cooldowns.set(sessionKey, Date.now());
}

export function isInCooldown(sessionKey: string, cooldownMs: number): boolean {
  const lastRun = cooldowns.get(sessionKey);
  if (!lastRun) return false;
  return Date.now() - lastRun < cooldownMs;
}

export function clearCooldown(sessionKey: string): void {
  cooldowns.delete(sessionKey);
}

/** For testing only. */
export function clearAllCooldowns(): void {
  cooldowns.clear();
}

// ── Gating ──

export type GatingOpts = {
  sessionKey: string;
  cooldownMs: number;
  memoryMode: boolean;
  messageCount: number;
  minMessages: number;
};

/**
 * Decide whether to run the ghost turn.
 * Returns false for insufficient messages, cooldown, or missing provider.
 * Memory mode bypasses cooldown.
 */
export function shouldRunGhostTurn(opts: GatingOpts): boolean {
  if (opts.messageCount < opts.minMessages) return false;
  if (!opts.memoryMode && isInCooldown(opts.sessionKey, opts.cooldownMs)) return false;
  if (!resolveProvider()) return false;
  return true;
}

// ── Triage prompts ──

const BASE_TRIAGE_PROMPT = `You are a memory retrieval assistant. Given recent messages from a conversation, decide if searching long-term memory would help the assistant respond better.

Output JSON only: { "search": boolean, "queries": string[] }
queries: 1-3 concise search phrases (noun phrases preferred).`;

const INTENSITY_CRITERIA: Record<GhostTurnIntensity, string> = {
  low: `Only search when the user EXPLICITLY references past conversations, prior decisions, or asks "do you remember". Do NOT search for general topics or self-contained requests.`,
  medium: `Search when: references to past conversations, preferences, decisions, people, projects, or recurring topics. Do NOT search for self-contained requests (simple questions, greetings, new instructions with no history reference).`,
  high: `Search whenever people, projects, preferences, contacts, decisions, patterns, or domain knowledge are mentioned. Err on the side of searching — it's better to search and find nothing than to miss relevant context.`,
};

export function buildTriagePrompt(intensity: GhostTurnIntensity): string {
  return `${BASE_TRIAGE_PROMPT}\n\n${INTENSITY_CRITERIA[intensity]}`;
}

// ── Message serialization ──

/**
 * Serialize recent messages into a compact text format for the triage LLM.
 * Each message is truncated to keep the triage call cheap.
 */
export function serializeMessages(messages: unknown[], windowSize: number): string {
  const recent = messages.slice(-windowSize);
  return recent
    .map((m) => {
      const msg = m as { role?: string; content?: string | unknown[] };
      const role = msg.role ?? "unknown";
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = (msg.content as Array<{ type?: string; text?: string }>)
          .filter((c) => c?.type === "text")
          .map((c) => c.text ?? "")
          .join(" ");
      }
      return `${role}: ${text.slice(0, 500)}`;
    })
    .join("\n");
}

// ── Cron query builder ──

/**
 * For cron/autonomous agents: extract search queries directly from the
 * job prompt without an LLM call. Returns 1-3 queries based on key
 * phrases in the prompt.
 */
export function buildCronQuery(prompt: string): string[] {
  if (!prompt || prompt.trim().length === 0) return [];

  // Take the first 500 chars and split into meaningful phrases
  const text = prompt.slice(0, 500).trim();

  // Split on sentence boundaries and take up to 3 meaningful chunks
  const sentences = text.split(/[.!?\n]+/).filter((s) => s.trim().length > 10);
  return sentences.slice(0, 3).map((s) => s.trim().slice(0, 100));
}

// ── Memory search execution ──

/**
 * Execute memory searches using the OpenClaw memory_search tool directly.
 * Deduplicates results across queries.
 */
export async function executeMemorySearch(
  queries: string[],
  tool: MemoryToolInstance,
  maxSearches: number,
): Promise<string[]> {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const query of queries.slice(0, maxSearches)) {
    try {
      const result = await tool.execute(`ghost-recall-${Date.now()}`, {
        action: "search",
        query,
        maxResults: 3,
      });

      for (const block of result.content) {
        if (block.type === "text" && block.text && !seen.has(block.text)) {
          seen.add(block.text);
          results.push(block.text);
        }
      }
    } catch {
      // Skip failed searches, continue with remaining queries
    }
  }

  return results;
}

// ── Result formatting ──

/**
 * Format memory search results into a markdown section for prependContext.
 */
export function formatMemoryResults(
  results: string[],
  maxChars: number,
  debug: boolean,
  queries: string[],
): string | null {
  if (results.length === 0) return null;

  let content = results.join("\n\n");
  if (content.length > maxChars) {
    content = content.slice(0, maxChars) + "\n...(truncated)";
  }

  const section = `## Recalled Memory\n\n${content}`;

  if (debug) {
    const debugInfo = `<!-- Ghost recall: searched for ${JSON.stringify(queries)}, found ${results.length} results -->`;
    return `${debugInfo}\n${section}`;
  }

  return section;
}

// ── Result type ──

export type GhostRecallResult = {
  /** Formatted markdown for prependContext, or null when nothing was found. */
  formatted: string | null;
  /** Raw individual memory result texts (for retrieval tracking). */
  rawResults: string[];
};

// ── Main orchestrator ──

/**
 * Full ghost turn pipeline: triage + search + format.
 * This is the entry point called from the adapter's before_prompt_build hook.
 */
export async function runGhostRecall(
  messages: unknown[],
  tool: MemoryToolInstance | null,
  opts: GhostTurnOpts,
): Promise<GhostRecallResult | null> {
  if (!tool) return null;

  const startTime = Date.now();
  const effectiveIntensity: GhostTurnIntensity = opts.memoryMode ? "high" : opts.intensity;
  const preset = INTENSITY_PRESETS[effectiveIntensity];
  const cooldownMs = opts.memoryMode ? 0 : preset.cooldownMs;
  const maxSearches = opts.memoryMode
    ? preset.maxSearches + 1
    : Math.min(opts.maxSearches, preset.maxSearches);

  // Gating
  if (!shouldRunGhostTurn({
    sessionKey: opts.sessionKey,
    cooldownMs,
    memoryMode: opts.memoryMode,
    messageCount: messages.length,
    minMessages: 2,
  })) {
    emitDiagnosticEvent({ type: "ghost_turn_skipped", sessionKey: opts.sessionKey, reason: "gating" });
    return null;
  }

  // Triage
  const systemPrompt = buildTriagePrompt(effectiveIntensity);
  const userContent = serializeMessages(messages, opts.windowSize);

  const triage = await callTriage(systemPrompt, userContent, {
    provider: opts.provider,
    model: opts.model,
  });

  if (!triage || !triage.search || triage.queries.length === 0) {
    emitDiagnosticEvent({
      type: "ghost_turn_no_search",
      sessionKey: opts.sessionKey,
      triageResult: triage,
      latencyMs: Date.now() - startTime,
    });
    updateCooldown(opts.sessionKey);
    return null;
  }

  // Search
  const results = await executeMemorySearch(triage.queries, tool, maxSearches);

  // Format
  const formatted = formatMemoryResults(results, opts.maxInjectedChars, opts.debug, triage.queries);

  updateCooldown(opts.sessionKey);

  emitDiagnosticEvent({
    type: "ghost_turn_complete",
    sessionKey: opts.sessionKey,
    queries: triage.queries,
    resultCount: results.length,
    latencyMs: Date.now() - startTime,
    injected: formatted !== null,
  });

  return { formatted, rawResults: results };
}

/**
 * Ghost recall for cron/autonomous agents.
 * Skips LLM triage — extracts queries from job prompt directly.
 */
export async function runCronRecall(
  prompt: string,
  tool: MemoryToolInstance | null,
  opts: { maxSearches: number; maxInjectedChars: number; debug: boolean; sessionKey: string },
): Promise<GhostRecallResult | null> {
  if (!tool) return null;

  const startTime = Date.now();
  const queries = buildCronQuery(prompt);
  if (queries.length === 0) return null;

  const results = await executeMemorySearch(queries, tool, opts.maxSearches);
  const formatted = formatMemoryResults(results, opts.maxInjectedChars, opts.debug, queries);

  emitDiagnosticEvent({
    type: "cron_recall_complete",
    sessionKey: opts.sessionKey,
    queries,
    resultCount: results.length,
    latencyMs: Date.now() - startTime,
  });

  return { formatted, rawResults: results };
}

// ── Expectations re-injection ──

/**
 * Format agent expectations as a compressed reminder for re-injection.
 * Returns null if no expectations are provided.
 */
export function formatExpectationsReminder(expectations: Expectation[]): string | null {
  if (!expectations || expectations.length === 0) return null;

  const lines: string[] = ["## Expectations Reminder", ""];
  for (const exp of expectations) {
    const actions = Array.isArray(exp.action) ? exp.action.join("/") : exp.action;
    lines.push(`- Use \`${exp.tool}\` → \`${actions}\` (min ${exp.min_calls}x per session)`);
  }
  return lines.join("\n");
}
